import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonRollbackStore } from './json-rollback-store.js';

describe('JsonRollbackStore', () => {
  let directory: string;
  let ledgerPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'issue-bridge-'));
    ledgerPath = join(directory, 'nested', 'ledger.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts empty when the file does not exist and creates the directory on write', async () => {
    const store = await JsonRollbackStore.open(ledgerPath);

    expect(await store.list()).toEqual([]);
    await store.set('github:acme/api:issue:1', { id: '10500', humanRef: 'ENG-5' });

    const written: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(written).toMatchObject({
      version: 1,
      entries: { 'github:acme/api:issue:1': { id: '10500', humanRef: 'ENG-5' } },
    });
  });

  it('survives reopening: the mapping persists across runs', async () => {
    const first = await JsonRollbackStore.open(ledgerPath);
    await first.set('issue:1', { id: '1', humanRef: 'ENG-1', url: 'https://j/browse/ENG-1' });
    await first.set('issue:2', { id: '2', humanRef: 'ENG-2' });

    const reopened = await JsonRollbackStore.open(ledgerPath);

    expect(await reopened.get('issue:1')).toEqual({
      id: '1',
      humanRef: 'ENG-1',
      url: 'https://j/browse/ENG-1',
    });
    // A missing `url` stays missing instead of becoming `undefined`.
    expect(Object.keys((await reopened.get('issue:2')) ?? {})).toEqual(['id', 'humanRef']);
    expect(await reopened.list()).toHaveLength(2);
  });

  it('returns null for an unknown key', async () => {
    const store = await JsonRollbackStore.open(ledgerPath);
    expect(await store.get('never-migrated')).toBeNull();
  });

  it('does not lose concurrent writes', async () => {
    const store = await JsonRollbackStore.open(ledgerPath);

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.set(`issue:${String(index)}`, {
          id: String(index),
          humanRef: `ENG-${String(index)}`,
        }),
      ),
    );

    const reopened = await JsonRollbackStore.open(ledgerPath);
    expect(await reopened.list()).toHaveLength(25);
  });

  it('leaves no temporary file behind', async () => {
    const store = await JsonRollbackStore.open(ledgerPath);
    await store.set('issue:1', { id: '1', humanRef: 'ENG-1' });

    await expect(readFile(`${ledgerPath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a corrupted ledger instead of recreating everything in the target', async () => {
    const store = await JsonRollbackStore.open(ledgerPath);
    await store.set('issue:1', { id: '1', humanRef: 'ENG-1' });

    await writeFile(ledgerPath, '{"version": 1, "entries": {"issue:1": {"id": 42}}}', 'utf8');
    await expect(JsonRollbackStore.open(ledgerPath)).rejects.toMatchObject({ code: 'validation' });

    await writeFile(ledgerPath, 'not json', 'utf8');
    await expect(JsonRollbackStore.open(ledgerPath)).rejects.toMatchObject({ code: 'validation' });
  });
});
