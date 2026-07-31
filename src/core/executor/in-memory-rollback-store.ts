import type { TargetItemRef } from '../ports/target-adapter.js';
import type { RollbackEntry, RollbackStore } from './executor.js';

/**
 * Implementação em memória do `RollbackStore`.
 *
 * Serve aos testes e ao `--dry-run`. A implementação durável (JSON/SQLite) vem
 * em fase posterior e não exige mudança no Executor.
 */
export class InMemoryRollbackStore implements RollbackStore {
  private readonly entries = new Map<string, TargetItemRef>();

  constructor(seed: RollbackEntry[] = []) {
    for (const entry of seed) this.entries.set(entry.sourceId, entry.targetRef);
  }

  get(sourceId: string): Promise<TargetItemRef | null> {
    return Promise.resolve(this.entries.get(sourceId) ?? null);
  }

  set(sourceId: string, targetRef: TargetItemRef): Promise<void> {
    this.entries.set(sourceId, targetRef);
    return Promise.resolve();
  }

  list(): Promise<RollbackEntry[]> {
    return Promise.resolve(
      [...this.entries.entries()].map(([sourceId, targetRef]) => ({ sourceId, targetRef })),
    );
  }
}
