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

  it('sem arquivo devolve null, o que força sync completo', async () => {
    expect(await store.read('acme/api')).toBeNull();
  });

  it('grava e relê a marca d’água, criando o diretório', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });

    expect(await new SyncStateStore(statePath).read('acme/api')).toEqual({
      version: 1,
      identifier: 'acme/api',
      lastSyncedAt: '2026-03-01T00:00:00Z',
    });
  });

  it('ignora marca de outro escopo em vez de sincronizar a partir dela', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });

    // Sincronizar `outro/repo` desde a data de `acme/api` perderia issues.
    expect(await store.read('outro/repo')).toBeNull();
  });

  it('recusa marca corrompida em vez de assumir uma data errada', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });

    await writeFile(statePath, '{"version":1,"identifier":"acme/api"}', 'utf8');
    await expect(store.read('acme/api')).rejects.toMatchObject({ code: 'validation' });

    await writeFile(statePath, 'não é json', 'utf8');
    await expect(store.read('acme/api')).rejects.toMatchObject({ code: 'validation' });
  });

  it('não deixa arquivo temporário para trás', async () => {
    await store.write({ version: 1, identifier: 'acme/api', lastSyncedAt: '2026-03-01T00:00:00Z' });
    await expect(new SyncStateStore(`${statePath}.tmp`).read('acme/api')).resolves.toBeNull();
  });
});
