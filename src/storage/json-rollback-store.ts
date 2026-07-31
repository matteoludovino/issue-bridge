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
  entries: z.record(TargetItemRefSchema),
});

type LedgerFile = z.infer<typeof LedgerFileSchema>;

/**
 * `RollbackStore` persistido em JSON.
 *
 * Garantias:
 *  - **durável por operação**: cada `set` grava o arquivo inteiro antes de
 *    resolver, então um `apply` interrompido (Ctrl+C, crash, rate limit fatal)
 *    não perde os mapeamentos já criados;
 *  - **atômico**: escreve em `<arquivo>.tmp` e faz `rename`, que é atômico no
 *    mesmo filesystem — nunca deixa um JSON truncado no lugar do ledger;
 *  - **serializado**: escritas são encadeadas numa promise, então chamadas
 *    concorrentes não se intercalam.
 *
 * Custo assumido: reescreve o arquivo inteiro a cada item. Para as ordens de
 * grandeza aqui (milhares de itens, arquivo de poucos MB) é irrelevante frente
 * ao custo de uma chamada HTTP; se virar gargalo, a troca é por SQLite — sem
 * tocar no Executor, que só conhece a interface.
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

  /** Carrega o ledger existente; arquivo ausente começa vazio. */
  static async open(filePath: string): Promise<JsonRollbackStore> {
    const entries = new Map<string, TargetItemRef>();

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (cause: unknown) {
      if (isNotFound(cause)) return new JsonRollbackStore(filePath, entries);
      throw new MigrationError({
        code: 'unknown',
        message: `Não foi possível ler o ledger em ${filePath}.`,
        cause,
      });
    }

    const parsed = LedgerFileSchema.safeParse(safeJsonParse(raw, filePath));
    if (!parsed.success) {
      // Ledger corrompido é perigoso: seguir em frente recriaria tudo no destino.
      throw new MigrationError({
        code: 'validation',
        message: `Ledger em ${filePath} está inválido (${parsed.error.issues[0]?.message ?? 'formato desconhecido'}). Corrija ou remova o arquivo antes de continuar.`,
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

  /** Encadeia as escritas para nunca haver dois `writeFile` simultâneos. */
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
        message: `Falha ao gravar o ledger em ${this.filePath}; interrompa a migração para não perder o mapeamento.`,
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
      message: `Ledger em ${filePath} não é JSON válido.`,
      cause,
    });
  }
}
