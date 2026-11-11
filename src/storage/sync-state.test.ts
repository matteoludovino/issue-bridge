import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncStateStore } from './sync-state.js';

describe('SyncStateStore', () => {
  let directory: string;
  let statePath: string;
  let store: SyncStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'issue-bridge-sync-'));
    statePath = join(directory, 'nested', 'sync-state.json');
    store = new SyncStateStore(statePath);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns null when there is no file, which forces a full sync', async () => {
    expect(await store.read('acme/api')).toBeNull();
  });

  it('writes and re-reads the watermark, creating the directory', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });

    expect(await new SyncStateStore(statePath).read('acme/api')).toEqual({
      version: 1,
      identifier: 'acme/api',
      lastSyncedAt: '2026-03-01T00:00:00Z',
    });
  });

  it('ignores a watermark from another scope instead of syncing from it', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });

    // Syncing `other/repo` from `acme/api`'s date would miss issues.
    expect(await store.read('other/repo')).toBeNull();
  });

  it('rejects a corrupted watermark instead of assuming a wrong date', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });

    await writeFile(statePath, '{"version":1,"identifier":"acme/api"}', 'utf8');
    await expect(store.read('acme/api')).rejects.toMatchObject({ code: 'validation' });

    await writeFile(statePath, 'not json', 'utf8');
    await expect(store.read('acme/api')).rejects.toMatchObject({ code: 'validation' });
  });

  it('leaves no temporary file behind', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });
    await expect(new SyncStateStore(`${statePath}.tmp`).read('acme/api')).resolves.toBeNull();
  });
});
