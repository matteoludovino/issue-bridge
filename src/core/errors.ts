/**
 * Adapter error taxonomy.
 *
 * Lets the Executor decide on retry/backoff without inspecting messages or HTTP
 * statuses of a specific tracker. Translating a native error → this taxonomy is
 * the adapter's responsibility.
 */
export type MigrationErrorCode =
  /** Invalid or expired credential. Never retry. */
  | 'auth'
  /** Authenticated, but not permitted to perform the operation. Never retry. */
  | 'forbidden'
  /** Resource does not exist in the source/target. */
  | 'not-found'
  /** Payload rejected (required field, invalid value). Never retry without changing the plan. */
  | 'validation'
  /** Rate limit. Retry honoring `retryAfterMs`. */
  | 'rate-limit'
  /** Transient network failure or 5xx. Retry with exponential backoff. */
  | 'transient'
  /** Resource already exists in the target — treated as `skipped`, not as a failure. */
  | 'conflict'
  /** Any other failure. Do not retry. */
  | 'unknown';

export interface MigrationErrorOptions {
  code: MigrationErrorCode;
  message: string;
  /** Overrides the `code` default when the adapter knows better. */
  retryable?: boolean;
  /** Wait time suggested by the server (`Retry-After` header), in ms. */
  retryAfterMs?: number;
  /** `EntityRef.key` of the entity involved. */
  subjectKey?: string;
  cause?: unknown;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<MigrationErrorCode> = new Set([
  'rate-limit',
  'transient',
]);

/** The single error type that crosses the adapter → core boundary. */
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
