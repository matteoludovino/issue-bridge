import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MigrationError } from '../core/errors.js';

const SyncStateSchema = z.object({
  version: z.literal(1),
  /** Escopo sincronizado (`owner/repo`). */
  identifier: z.string().min(1),
  /** Instante do início da última extração bem-sucedida, em ISO 8601. */
  lastSyncedAt: z.string().min(1),
});

export type SyncState = z.infer<typeof SyncStateSchema>;

/**
 * Marca d'água do `sync`: até quando a origem já foi lida.
 *
 * Fica separada do ledger de propósito. O ledger responde "o que já existe no
 * destino"; isto responde "até onde já leguei a origem". São perguntas
 * diferentes, com ciclos de vida diferentes — apagar a marca d'água força uma
 * releitura completa sem perder as correspondências já criadas.
 *
 * A marca é o instante de INÍCIO da extração, não o de término: qualquer item
 * alterado durante a execução entra na próxima janela em vez de ser perdido.
 */
export class SyncStateStore {
  constructor(private readonly filePath: string) {}

  /**
   * Devolve `null` quando não há marca — ou quando a marca é de outro escopo,
   * o que evita sincronizar `repo-b` a partir da data de `repo-a`.
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
