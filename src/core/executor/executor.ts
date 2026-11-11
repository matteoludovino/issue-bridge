import { MigrationError, isMigrationError } from '../errors.js';
import {
  hasBlockingErrors,
  type MigrationPlan,
  type PlanAction,
  type PlanFinding,
} from '../models/migration-plan.js';
import type { AttachmentFetcher } from '../ports/attachment-fetcher.js';
import type { Sleeper } from '../ports/clock.js';
import type { TargetAdapter, TargetItemRef } from '../ports/target-adapter.js';

/** Minimal logger. The real implementation (Pino) lives in the infrastructure layer. */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RollbackEntry {
  /** Idempotency key (see `storeKeyFor`). */
  sourceId: string;
  targetRef: TargetItemRef;
}

/**
 * Source → target mapping ledger.
 *
 * Serves three purposes, in this order: idempotency (the Executor checks it
 * before creating), `sync` (resolves where to write updates) and `rollback`
 * (lists what was created, for best-effort removal). The durable implementation
 * (JSON/SQLite) comes in a later phase.
 */
export interface RollbackStore {
  get(sourceId: string): Promise<TargetItemRef | null>;
  set(sourceId: string, targetRef: TargetItemRef): Promise<void>;
  list(): Promise<RollbackEntry[]>;
}

export interface ExecutionError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SucceededOutcome {
  action: PlanAction;
  /** `null` when the target returns no reference (some link types). */
  targetRef: TargetItemRef | null;
  /** Attempts used (1 = no retry). `0` in dry-run. */
  attempts: number;
}

export interface SkippedOutcome {
  action: PlanAction;
  reason: 'skipped_already_migrated';
  targetRef: TargetItemRef;
}

export interface FailedOutcome {
  action: PlanAction;
  error: ExecutionError;
  attempts: number;
}

/** Retry policy. Applies only to `MigrationError` with `retryable: true`. */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export interface ExecutionResult {
  succeeded: SucceededOutcome[];
  skipped: SkippedOutcome[];
  failed: FailedOutcome[];
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
}

export interface ExecuteOptions {
  /**
   * Goes through dependency resolution and idempotency exactly like a real
   * run, but never calls the `TargetAdapter` creation methods.
   * This is what backs `analyze` without duplicating the ordering logic.
   */
  dryRun?: boolean;
  /** Overrides `DEFAULT_RETRY_POLICY` (comes from the config in production). */
  retry?: RetryPolicy;
  /**
   * Called after each action. Lets the CLI show real progress without
   * inferring state from log messages.
   */
  onProgress?: (progress: { done: number; total: number; failures: number }) => void;
  /**
   * Independent actions run in parallel. Defaults to 1 (sequential, in plan
   * order) so that library behavior is deterministic;
   * the CLI passes the value from the config.
   */
  concurrency?: number;
}

/** Thrown when the plan has `error` findings. Nothing is executed. */
export class MigrationBlockedError extends Error {
  readonly findings: PlanFinding[];

  constructor(findings: PlanFinding[]) {
    const blocking = findings.filter((finding) => finding.severity === 'error');
    super(
      `Plan blocked by ${String(blocking.length)} error(s): ${blocking
        .map((finding) => `${finding.code} — ${finding.message}`)
        .join('; ')}`,
    );
    this.name = 'MigrationBlockedError';
    this.findings = blocking;
  }
}

/**
 * Idempotency key of an action in the RollbackStore.
 *
 * Actions that create an entity with its own identity in the source are keyed
 * by `sourceRef.id` — that is what enables `sync` and dependency resolution
 * across runs. Actions without an entity of their own (label, component, link,
 * transition) use the action id, which is already deterministic; otherwise a
 * `transition_issue` would collide with the `create_issue` of the same issue and
 * be wrongly skipped.
 */
export function storeKeyFor(action: PlanAction): string {
  switch (action.kind) {
    case 'create_epic':
    case 'create_version':
    case 'create_issue':
    case 'create_comment':
    case 'create_attachment':
      return action.sourceRef.id;
    case 'create_component':
    case 'create_label':
    case 'create_link':
    case 'transition_issue':
      return action.id;
  }
}

interface ScheduleContext {
  plan: MigrationPlan;
  result: ExecutionResult;
  actionById: Map<string, PlanAction>;
  resolved: Map<string, TargetItemRef>;
  dryRun: boolean;
  retry: RetryPolicy;
  concurrency: number;
  onProgress: ExecuteOptions['onProgress'];
}

/** Target references already resolved for an action. */
interface ResolvedDependencies {
  epicRef?: TargetItemRef;
  versionRef?: TargetItemRef;
  parentRef?: TargetItemRef;
  issueRef?: TargetItemRef;
  fromRef?: TargetItemRef;
  toRef?: TargetItemRef;
}

export class Executor {
  constructor(
    private readonly target: TargetAdapter,
    private readonly store: RollbackStore,
    private readonly logger: Logger,
    /**
     * Required only when the plan has `create_attachment`. When absent, those
     * actions fail individually — the rest of the migration proceeds.
     */
    private readonly attachments?: AttachmentFetcher,
    /** Injectable so backoff tests do not spend real time. */
    private readonly sleeper: Sleeper = { sleep: realSleep },
  ) {}

  async execute(plan: MigrationPlan, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    if (hasBlockingErrors(plan)) throw new MigrationBlockedError(plan.findings);

    const dryRun = opts.dryRun ?? false;
    const retry = opts.retry ?? DEFAULT_RETRY_POLICY;
    const startedAt = new Date().toISOString();
    const result: ExecutionResult = {
      succeeded: [],
      skipped: [],
      failed: [],
      startedAt,
      finishedAt: startedAt,
      dryRun,
    };

    const concurrency = Math.max(1, opts.concurrency ?? 1);
    const planIndex = new Map(plan.actions.map((action, index) => [action.id, index]));

    this.logger.info('Starting plan execution', {
      generatedAt: plan.generatedAt,
      actions: plan.actions.length,
      concurrency,
      dryRun,
    });

    await this.schedule({
      plan,
      result,
      actionById: new Map(plan.actions.map((action) => [action.id, action])),
      // Per-run cache; in dry-run it is the only record, since nothing is persisted.
      resolved: new Map<string, TargetItemRef>(),
      dryRun,
      retry,
      concurrency,
      onProgress: opts.onProgress,
    });

    // Results are put back in PLAN order, not completion order: the report,
    // diffs and tests must be deterministic even with parallelism.
    const inPlanOrder = <T extends { action: PlanAction }>(items: T[]): T[] =>
      [...items].sort(
        (left, right) =>
          (planIndex.get(left.action.id) ?? 0) - (planIndex.get(right.action.id) ?? 0),
      );
    result.succeeded = inPlanOrder(result.succeeded);
    result.skipped = inPlanOrder(result.skipped);
    result.failed = inPlanOrder(result.failed);

    result.finishedAt = new Date().toISOString();
    this.logger.info('Execution finished', {
      succeeded: result.succeeded.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    });
    return result;
  }

  /**
   * Dependency-aware scheduler.
   *
   * An action starts once every `dependsOn` has completed. If any dependency
   * failed, the action is marked as failed right away — without spending an
   * attempt on a reference that will never exist. With `concurrency: 1` the
   * behavior is identical to the sequential loop, in plan order.
   */
  private async schedule(context: ScheduleContext): Promise<void> {
    const { plan, result, concurrency } = context;
    const status = new Map<string, 'ok' | 'fail'>();
    const queue = [...plan.actions];
    const inFlight = new Map<string, Promise<void>>();

    const report = (): void => {
      context.onProgress?.({
        done: result.succeeded.length + result.skipped.length + result.failed.length,
        total: plan.actions.length,
        failures: result.failed.length,
      });
    };

    const fail = (action: PlanAction, message: string): void => {
      status.set(action.id, 'fail');
      result.failed.push({
        action,
        error: { code: 'validation', message, retryable: false },
        attempts: 1,
      });
      this.logger.error('Action not executed', { actionId: action.id, message });
      report();
    };

    while (queue.length > 0 || inFlight.size > 0) {
      for (let index = 0; index < queue.length && inFlight.size < concurrency; ) {
        const action = queue[index];
        if (action === undefined) break;

        const readiness = readinessOf(action, status);
        if (readiness === 'waiting') {
          index += 1;
          continue;
        }

        // `splice` shifts the queue, so the index does not advance.
        queue.splice(index, 1);

        if (readiness === 'blocked') {
          fail(action, `A dependency of "${action.id}" failed; the action was dropped.`);
          continue;
        }

        const promise = this.runAction(action, context).then((outcome) => {
          status.set(action.id, outcome);
          inFlight.delete(action.id);
          report();
        });
        inFlight.set(action.id, promise);
      }

      if (inFlight.size === 0) {
        if (queue.length === 0) break;
        // Nothing ready and nothing running: only happens if `dependsOn` points
        // outside the plan. Failing explicitly is better than hanging.
        for (const action of queue) {
          fail(action, `Action "${action.id}" depends on something that does not exist in the plan.`);
        }
        break;
      }

      await Promise.race(inFlight.values());
    }
  }

  /** Body of an action: idempotency, dependencies, write and record. */
  private async runAction(action: PlanAction, context: ScheduleContext): Promise<'ok' | 'fail'> {
    const { plan, result, resolved, actionById, dryRun, retry } = context;
    const key = storeKeyFor(action);

    const existing = await this.store.get(key);
    if (existing !== null) {
      resolved.set(action.id, existing);
      result.skipped.push({ action, reason: 'skipped_already_migrated', targetRef: existing });
      this.logger.info('Action already migrated, skipping', {
        actionId: action.id,
        targetRef: existing.humanRef,
      });
      return 'ok';
    }

    let attempts = 0;
    try {
      const dependencies = await this.resolveDependencies(action, actionById, resolved);

      let targetRef: TargetItemRef | null;
      if (dryRun) {
        targetRef = simulateRef(action);
      } else {
        const attempt = await this.attemptDispatch(
          action,
          plan.targetProjectKey,
          dependencies,
          retry,
        );
        attempts = attempt.attempts;
        if (!attempt.ok) throw attempt.error;
        targetRef = attempt.targetRef;
      }

      if (targetRef !== null) {
        resolved.set(action.id, targetRef);
        if (!dryRun) await this.store.set(key, targetRef);
      }

      result.succeeded.push({ action, targetRef, attempts });
      this.logger.info(dryRun ? 'Action simulated' : 'Action completed', {
        actionId: action.id,
        kind: action.kind,
        attempts,
        targetRef: targetRef?.humanRef,
      });
      return 'ok';
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      result.failed.push({ action, error: normalized, attempts: Math.max(attempts, 1) });
      this.logger.error('Action failed', {
        actionId: action.id,
        kind: action.kind,
        attempts: Math.max(attempts, 1),
        code: normalized.code,
        message: normalized.message,
      });
      return 'fail';
    }
  }

  /**
   * Runs the action with exponential retry, only for errors the adapter classified
   * as retryable (`rate-limit`, `transient`). Validation or permission errors
   * fail on the first attempt — retrying would not change the outcome.
   */
  private async attemptDispatch(
    action: PlanAction,
    projectKey: string,
    deps: ResolvedDependencies,
    policy: RetryPolicy,
  ): Promise<
    | { ok: true; targetRef: TargetItemRef | null; attempts: number }
    | { ok: false; error: unknown; attempts: number }
  > {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const targetRef = await this.dispatch(action, projectKey, deps);
        return { ok: true, targetRef, attempts };
      } catch (error: unknown) {
        const retryable = isMigrationError(error) && error.retryable;
        if (!retryable || attempts >= policy.maxAttempts) return { ok: false, error, attempts };

        const delayMs = backoffDelayMs(
          policy,
          attempts,
          isMigrationError(error) ? error.retryAfterMs : undefined,
        );
        this.logger.warn('Retryable failure; waiting before the next attempt', {
          actionId: action.id,
          attempt: attempts,
          delayMs,
          code: isMigrationError(error) ? error.code : 'unknown',
        });
        await this.sleeper.sleep(delayMs);
      }
    }
  }

  /**
   * Translates action ids (`epicActionId`, `issueActionId`, `dependsOn`) into
   * actual `TargetItemRef`s, via the run cache or the RollbackStore (which allows
   * resuming an interrupted migration).
   */
  private async resolveDependencies(
    action: PlanAction,
    actionById: Map<string, PlanAction>,
    resolved: Map<string, TargetItemRef>,
  ): Promise<ResolvedDependencies> {
    const lookup = async (actionRefId: string): Promise<TargetItemRef> => {
      const cached = resolved.get(actionRefId);
      if (cached !== undefined) return cached;

      const referenced = actionById.get(actionRefId);
      if (referenced === undefined) {
        throw new MigrationError({
          code: 'validation',
          message: `Action "${action.id}" references "${actionRefId}", which does not exist in the plan.`,
        });
      }

      const stored = await this.store.get(storeKeyFor(referenced));
      if (stored === null) {
        throw new MigrationError({
          code: 'validation',
          message: `Dependency "${actionRefId}" of "${action.id}" was never created (it failed or was skipped).`,
        });
      }
      resolved.set(actionRefId, stored);
      return stored;
    };

    // `dependsOn` is the safety net: it ensures nothing runs before what it
    // needs, even if the action does not use the reference directly.
    if (!isCatalog(action)) {
      for (const dependencyId of action.dependsOn) await lookup(dependencyId);
    }

    switch (action.kind) {
      case 'create_issue':
        return {
          ...(action.epicActionId === undefined
            ? {}
            : { epicRef: await lookup(action.epicActionId) }),
          ...(action.versionActionId === undefined
            ? {}
            : { versionRef: await lookup(action.versionActionId) }),
          ...(action.parentActionId === undefined
            ? {}
            : { parentRef: await lookup(action.parentActionId) }),
        };
      case 'create_comment':
      case 'create_attachment':
      case 'transition_issue':
        return { issueRef: await lookup(action.issueActionId) };
      case 'create_link':
        return {
          fromRef: await lookup(action.fromIssueActionId),
          toRef: await lookup(action.toIssueActionId),
        };
      default:
        return {};
    }
  }

  private async dispatch(
    action: PlanAction,
    projectKey: string,
    deps: ResolvedDependencies,
  ): Promise<TargetItemRef | null> {
    switch (action.kind) {
      case 'create_epic':
        return this.target.createEpic({
          projectKey,
          name: action.name,
          fields: action.fields,
          sourceRef: action.sourceRef,
          ...(action.description === undefined ? {} : { description: action.description }),
        });

      case 'create_version':
        return this.target.createVersion({
          projectKey,
          name: action.name,
          sourceRef: action.sourceRef,
          ...(action.description === undefined ? {} : { description: action.description }),
          ...(action.releaseDate === undefined ? {} : { releaseDate: action.releaseDate }),
        });

      case 'create_component':
        return this.target.createComponent({
          projectKey,
          name: action.name,
          ...(action.description === undefined ? {} : { description: action.description }),
        });

      case 'create_label':
        return this.target.createLabel({ projectKey, name: action.name });

      case 'create_issue':
        return this.target.createIssue({
          projectKey,
          issueType: action.issueType,
          summary: action.summary,
          description: action.description,
          labels: action.labels,
          assignees: action.assignees,
          fields: action.fields,
          sourceRef: action.sourceRef,
          ...(action.priority === undefined ? {} : { priority: action.priority }),
          ...(deps.epicRef === undefined ? {} : { epicRef: deps.epicRef }),
          ...(deps.versionRef === undefined ? {} : { versionRef: deps.versionRef }),
          ...(deps.parentRef === undefined ? {} : { parentRef: deps.parentRef }),
        });

      case 'create_comment':
        return this.target.createComment({
          issueRef: requireRef(deps.issueRef, action),
          body: action.body,
          sourceRef: action.sourceRef,
        });

      case 'create_attachment': {
        const issueRef = requireRef(deps.issueRef, action);
        if (this.attachments === undefined) {
          throw new MigrationError({
            code: 'validation',
            message: `Action "${action.id}" requires an AttachmentFetcher, and the executor was built without one.`,
          });
        }
        // The download happens HERE, not in the target adapter: only the source
        // side holds the credential able to download the file.
        const payload = await this.attachments.fetch(action.url, action.filename);
        return this.target.createAttachment({
          issueRef,
          payload,
          sourceUrl: action.url,
          sourceRef: action.sourceRef,
        });
      }

      case 'create_link': {
        const created = await this.target.createLink({
          fromRef: requireRef(deps.fromRef, action),
          toRef: requireRef(deps.toRef, action),
          linkType: action.canonicalType,
        });
        // Targets that return no link reference still need an idempotency
        // marker, otherwise the link is recreated on every run.
        return created ?? { id: action.id, humanRef: action.id };
      }

      case 'transition_issue': {
        const issueRef = requireRef(deps.issueRef, action);
        await this.target.transitionIssue(issueRef, action.targetStatus);
        return issueRef;
      }
    }
  }
}

/** `waiting` = a dependency is still running; `blocked` = a dependency failed. */
function readinessOf(
  action: PlanAction,
  status: Map<string, 'ok' | 'fail'>,
): 'ready' | 'waiting' | 'blocked' {
  if (isCatalog(action)) return 'ready';

  for (const dependencyId of action.dependsOn) {
    const state = status.get(dependencyId);
    if (state === undefined) return 'waiting';
    if (state === 'fail') return 'blocked';
  }
  return 'ready';
}

function isCatalog(
  action: PlanAction,
): action is Extract<PlanAction, { kind: 'create_epic' | 'create_version' | 'create_component' | 'create_label' }> {
  return (
    action.kind === 'create_epic' ||
    action.kind === 'create_version' ||
    action.kind === 'create_component' ||
    action.kind === 'create_label'
  );
}

function requireRef(ref: TargetItemRef | undefined, action: PlanAction): TargetItemRef {
  if (ref !== undefined) return ref;
  throw new MigrationError({
    code: 'validation',
    message: `Dependencies for action "${action.id}" were not resolved.`,
  });
}

/**
 * Deterministic exponential backoff (no jitter, so the result is
 * reproducible). The server's `retryAfterMs` is NOT capped by `maxDelayMs`:
 * when the target says how long to wait, ignoring it only burns attempts.
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function simulateRef(action: PlanAction): TargetItemRef {
  return { id: `dry-run:${action.id}`, humanRef: `DRY-RUN(${action.id})` };
}

function normalizeError(error: unknown): ExecutionError {
  if (isMigrationError(error)) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) {
    return { code: 'unknown', message: error.message, retryable: false };
  }
  return { code: 'unknown', message: String(error), retryable: false };
}
