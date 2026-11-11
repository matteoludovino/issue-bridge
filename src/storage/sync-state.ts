import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MigrationError } from '../core/errors.js';

const SyncStateSchema = z.object({
  version: z.literal(1),
  /** Synced scope (`owner/repo`). */
  identifier: z.string().min(1),
  /** Start time of the last successful extraction, in ISO 8601. */
  lastSyncedAt: z.string().min(1),
});

export type SyncState = z.infer<typeof SyncStateSchema>;

/**
 * `sync` watermark: up to when the source has already been read.
 *
 * Kept separate from the ledger on purpose. The ledger answers "what already exists
 * in the target"; this answers "how far have I read the source". They are different
 * questions, with different lifecycles — deleting the watermark forces a full
 * re-read without losing the mappings already created.
 *
 * The watermark is the time the extraction STARTED, not when it ended: any item
 * changed during the run falls into the next window instead of being lost.
 */
export class SyncStateStore {
  constructor(private readonly filePath: string) {}

  /**
   * Returns `null` when there is no watermark — or when it belongs to another scope,
   * which prevents syncing `repo-b` from `repo-a`'s date.
   */
  async read(identifier: string): Promise<SyncState | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (cause: unknown) {
      if (isNotFound(cause)) return null;
      throw new MigrationError({
        code: 'unknown',
        message: `Could not read the sync state at ${this.filePath}.`,
        cause,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (cause: unknown) {
      throw new MigrationError({
        code: 'validation',
        message: `Sync state at ${this.filePath} is not valid JSON. Remove the file to force a full sync.`,
        cause,
      });
    }

    const parsed = SyncStateSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MigrationError({
        code: 'validation',
        message: `Sync state at ${this.filePath} is invalid. Remove the file to force a full sync.`,
      });
    }

    return parsed.data.identifier === identifier ? parsed.data : null;
  }

  async write(state: SyncState): Promise<void> {
    const temporary = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temporary, this.filePath);
    } catch (cause: unknown) {
      throw new MigrationError({
        code: 'unknown',
        message: `Failed to write the sync state at ${this.filePath}.`,
        cause,
      });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}
