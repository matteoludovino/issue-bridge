import type { TargetItemRef } from '../ports/target-adapter.js';
import type { RollbackEntry, RollbackStore } from './executor.js';

/**
 * In-memory implementation of `RollbackStore`.
 *
 * Used by tests and by `--dry-run`. The durable implementation (JSON/SQLite)
 * comes in a later phase and requires no change to the Executor.
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
