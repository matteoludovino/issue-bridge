/**
 * Taxonomia de erros dos adapters.
 *
 * Existe para que o Executor decida retry/backoff sem inspecionar mensagens ou
 * status HTTP de um tracker específico. Traduzir erro nativo → esta taxonomia é
 * responsabilidade do adapter.
 */
export type MigrationErrorCode =
  /** Credencial inválida ou expirada. Nunca retentar. */
  | 'auth'
  /** Autenticado, mas sem permissão para a operação. Nunca retentar. */
  | 'forbidden'
  /** Recurso inexistente na origem/destino. */
  | 'not-found'
  /** Payload rejeitado (campo obrigatório, valor inválido). Nunca retentar sem mudar o plano. */
  | 'validation'
  /** Rate limit. Retentar respeitando `retryAfterMs`. */
  | 'rate-limit'
  /** Falha transitória de rede ou 5xx. Retentar com backoff exponencial. */
  | 'transient'
  /** Recurso já existe no destino — tratado como `skipped`, não como falha. */
  | 'conflict'
  /** Qualquer outra falha. Não retentar. */
  | 'unknown';

export interface MigrationErrorOptions {
  code: MigrationErrorCode;
  message: string;
  /** Sobrescreve o default de `code` quando o adapter tem informação melhor. */
  retryable?: boolean;
  /** Espera sugerida pelo servidor (header `Retry-After`), em ms. */
  retryAfterMs?: number;
  /** `EntityRef.key` da entidade envolvida. */
  subjectKey?: string;
  cause?: unknown;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<MigrationErrorCode> = new Set([
  'rate-limit',
  'transient',
]);

/** Erro único que atravessa a fronteira adapter → core. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly subjectKey: string | undefined;

  constructor(options: MigrationErrorOptions) {
    super(options.message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'MigrationError';
    this.code = options.code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(options.code);
    this.retryAfterMs = options.retryAfterMs;
    this.subjectKey = options.subjectKey;
  }
}

export function isMigrationError(value: unknown): value is MigrationError {
  return value instanceof MigrationError;
}
