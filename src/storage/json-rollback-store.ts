import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MigrationError } from '../core/errors.js';
import type { RollbackEntry, RollbackStore } from '../core/executor/executor.js';
import type { TargetItemRef } from '../core/ports/target-adapter.js';

const TargetItemRefSchema = z.object({
  id: z.string().min(1),
  humanRef: z.string().min(1),
  url: z.string().optional(),
});

const LedgerFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  entries: z.record(z.string(), TargetItemRefSchema),
});

type LedgerFile = z.infer<typeof LedgerFileSchema>;

/**
 * JSON-backed `RollbackStore`.
 *
 * Guarantees:
 *  - **durable per operation**: each `set` writes the whole file before
 *    resolving, so an interrupted `apply` (Ctrl+C, crash, fatal rate limit)
 *    does not lose the mappings already created;
 *  - **atomic**: writes to `<file>.tmp` and then calls `rename`, which is atomic on
 *    the same filesystem — it never leaves a truncated JSON in place of the ledger;
 *  - **serialized**: writes are chained on a promise, so concurrent calls
 *    do not interleave.
 *
 * Accepted cost: the whole file is rewritten on every item. At the scale
 * involved here (thousands of items, a file of a few MB) that is negligible next
 * to the cost of an HTTP call; if it becomes a bottleneck, swap in SQLite —
 * without touching the Executor, which only knows the interface.
 */
export class JsonRollbackStore implements RollbackStore {
  private readonly entries: Map<string, TargetItemRef>;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    entries: Map<string, TargetItemRef>,
  ) {
    this.entries = entries;
  }

  /** Loads the existing ledger; a missing file starts out empty. */
  static async open(filePath: string): Promise<JsonRollbackStore> {
    const entries = new Map<string, TargetItemRef>();

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (cause: unknown) {
      if (isNotFound(cause)) return new JsonRollbackStore(filePath, entries);
      throw new MigrationError({
        code: 'unknown',
        message: `Could not read the ledger at ${filePath}.`,
        cause,
      });
    }

    const parsed = LedgerFileSchema.safeParse(safeJsonParse(raw, filePath));
    if (!parsed.success) {
      // A corrupted ledger is dangerous: carrying on would recreate everything in the target.
      throw new MigrationError({
        code: 'validation',
        message: `Ledger at ${filePath} is invalid (${parsed.error.issues[0]?.message ?? 'unknown format'}). Fix or remove the file before continuing.`,
      });
    }

    for (const [sourceId, targetRef] of Object.entries(parsed.data.entries)) {
      entries.set(sourceId, targetRef);
    }
    return new JsonRollbackStore(filePath, entries);
  }

  get(sourceId: string): Promise<TargetItemRef | null> {
    return Promise.resolve(this.entries.get(sourceId) ?? null);
  }

  set(sourceId: string, targetRef: TargetItemRef): Promise<void> {
    this.entries.set(sourceId, targetRef);
    return this.enqueueFlush();
  }

  list(): Promise<RollbackEntry[]> {
    return Promise.resolve(
      [...this.entries.entries()].map(([sourceId, targetRef]) => ({ sourceId, targetRef })),
    );
  }

  /** Chains the writes so there are never two `writeFile` calls at once. */
  private enqueueFlush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.flush());
    return this.writeQueue;
  }

  private async flush(): Promise<void> {
    const payload: LedgerFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: Object.fromEntries(this.entries),
    };

    const temporary = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(temporary, this.filePath);
    } catch (cause: unknown) {
      throw new MigrationError({
        code: 'unknown',
        message: `Failed to write the ledger at ${this.filePath}; stop the migration so the mapping is not lost.`,
        cause,
      });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function safeJsonParse(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause: unknown) {
    throw new MigrationError({
      code: 'validation',
      message: `Ledger at ${filePath} is not valid JSON.`,
      cause,
    });
  }
}
