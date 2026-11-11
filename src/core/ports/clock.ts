/**
 * Time and identity as ports.
 *
 * Rationale: the Planner needs to record `createdAt` and `planId`, but must be a
 * pure, deterministic function in tests. Injecting `Clock`/`IdGenerator` keeps it
 * pure without resorting to global `Date` mocks.
 */
export interface Clock {
  /** Current instant in ISO 8601 with offset. */
  now(): string;
}

export interface IdGenerator {
  /** Opaque, unique id (planId, runId). */
  next(): string;
}

/** Cooperative wait, injected so the Executor's backoff does not stall tests. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
