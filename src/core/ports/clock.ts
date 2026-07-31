/**
 * Tempo e identidade como portas.
 *
 * Motivo: o Planner precisa gravar `createdAt` e `planId`, mas deve ser função
 * pura e determinística nos testes. Injetar `Clock`/`IdGenerator` mantém a
 * pureza sem recorrer a mocks globais de `Date`.
 */
export interface Clock {
  /** Instante atual em ISO 8601 com offset. */
  now(): string;
}

export interface IdGenerator {
  /** Id opaco e único (planId, runId). */
  next(): string;
}

/** Espera cooperativa, injetada para o backoff do Executor não travar testes. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
