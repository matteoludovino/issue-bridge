import { toExtractOptions, toMappingConfig, toRetryPolicy } from '../composition.js';
import type { MigrationConfig } from '../config/schema.js';
import {
  Executor,
  MigrationBlockedError,
  type ExecutionResult,
  type Logger,
  type RollbackStore,
} from '../core/executor/executor.js';
import type { IssueModel } from '../core/models/issue-model.js';
import { hasBlockingErrors, type MigrationPlan } from '../core/models/migration-plan.js';
import type { AttachmentFetcher } from '../core/ports/attachment-fetcher.js';
import type { Clock, Sleeper } from '../core/ports/clock.js';
import type { SourceAdapter } from '../core/ports/source-adapter.js';
import type { TargetAdapter } from '../core/ports/target-adapter.js';
import { buildPlan } from '../core/planner/planner.js';
import { renderExecutionReport, renderPlanReport } from '../reports/migration-report.js';
import {
  artifactPath,
  readExecution,
  readPlan,
  readSnapshot,
  writeJson,
  writeText,
} from '../storage/artifacts.js';
import type { SyncStateStore } from '../storage/sync-state.js';
import { ProgressLine, color, formatNumber, symbol } from '../utils/ui.js';

/**
 * CLI commands.
 *
 * Each function receives already-constructed dependencies and returns the exit
 * code — nothing here knows that the source is GitHub or the target is Jira, and
 * nothing here calls `process.exit`. That is what makes the commands testable
 * with fake adapters.
 */

export const EXIT = {
  /** All good. */
  ok: 0,
  /** Ran, but the plan has a blocking error or an action failed. */
  problems: 1,
  /** Could not run: invalid config, credentials or artifact. */
  aborted: 2,
} as const;

export interface CommandDeps {
  config: MigrationConfig;
  source: SourceAdapter;
  target: TargetAdapter;
  store: RollbackStore;
  logger: Logger;
  clock: Clock;
  attachments?: AttachmentFetcher;
  /** Sync watermark. When absent, `sync` always runs a full pass. */
  syncState?: SyncStateStore;
  sleeper?: Sleeper;
  /** DATA output (stdout). Human logging goes to stderr, through `logger`. */
  write?: (text: string) => void;
}

export interface ArtifactOptions {
  outDir: string;
}

/** Validates both credentials before doing any heavy work. */
export async function runLogin(deps: CommandDeps): Promise<number> {
  await deps.source.authenticate();
  deps.logger.info(`${symbol.ok} Source credentials are valid (${deps.source.platformName}).`);

  await deps.target.authenticate();
  deps.logger.info(`${symbol.ok} Target credentials are valid (${deps.target.platformName}).`);

  return EXIT.ok;
}

/** Extracts the source into a snapshot on disk, without touching the target. */
export async function runExport(
  deps: CommandDeps,
  options: ArtifactOptions & { out?: string },
): Promise<number> {
  const model = await extractModel(deps);
  const target = options.out ?? artifactPath(options.outDir, 'snapshot');

  await writeJson(target, model);
  deps.logger.info(
    `${symbol.ok} Snapshot written to ${target}: ${formatNumber(model.issues.length)} issue(s), ` +
      `${formatNumber(countComments(model))} comment(s), ${formatNumber(countAttachments(model))} attachment(s).`,
  );
  return EXIT.ok;
}

/**
 * Builds and writes the plan without writing to the target. Exit code 1 when
 * there is a blocking error, which makes `analyze` usable as a CI gate.
 */
export async function runAnalyze(
  deps: CommandDeps,
  options: ArtifactOptions & { snapshot?: string },
): Promise<number> {
  const plan = await preparePlan(deps, options);

  await writeJson(artifactPath(options.outDir, 'plan'), plan);
  await writeText(artifactPath(options.outDir, 'report'), renderPlanReport(plan));

  summarizePlan(deps, plan, options.outDir);
  return hasBlockingErrors(plan) ? EXIT.problems : EXIT.ok;
}

export interface ApplyOptions extends ArtifactOptions {
  /** Plan already produced by `analyze`; when absent, it is built now. */
  plan?: string;
  dryRun?: boolean;
  /** Without this, `apply` simulates — writing to the target is irreversible. */
  yes?: boolean;
  /** Progress line on stderr. Only the CLI turns it on; quiet by default. */
  progress?: boolean;
}

export async function runApply(deps: CommandDeps, options: ApplyOptions): Promise<number> {
  const plan =
    options.plan === undefined
      ? await preparePlan(deps, options)
      : await readPlan(options.plan);

  return applyPlan(deps, plan, options);
}

export interface SyncOptions extends ApplyOptions {
  /** Overrides the watermark (ISO 8601). */
  since?: string;
  /** Ignores the watermark and re-reads the whole source. */
  full?: boolean;
}

/**
 * Incremental migration: reads from the source only what changed since the last
 * successful `sync`, applies it, and only then advances the watermark.
 *
 * The stored watermark is the moment the extraction STARTED. An item changed
 * during the run falls into the next window instead of being lost — the cost is
 * reprocessing a few items, which the ledger's idempotency absorbs.
 *
 * Known limit: `sync` brings NEW items (issues, comments, status transitions). A
 * change to the title or body of an already-migrated item is not propagated —
 * the plan has no update action.
 */
export async function runSync(deps: CommandDeps, options: SyncOptions): Promise<number> {
  const identifier = deps.config.source.identifier;
  const state = options.full === true ? null : ((await deps.syncState?.read(identifier)) ?? null);
  const since = options.since ?? state?.lastSyncedAt;

  // Captured BEFORE the extraction, on purpose.
  const startedAt = deps.clock.now();

  deps.logger.info(
    since === undefined
      ? `Full sync of ${identifier} (no previous watermark).`
      : `Incremental sync of ${identifier}: changes since ${since}.`,
  );

  const plan = await preparePlan(deps, { ...options, ...(since === undefined ? {} : { since }) });

  if (plan.actions.length === 0) {
    deps.logger.info(`${symbol.ok} Nothing new in the source.`);
    await advanceWatermark(deps, identifier, startedAt, options);
    return EXIT.ok;
  }

  const code = await applyPlan(deps, plan, options);
  if (code === EXIT.ok) await advanceWatermark(deps, identifier, startedAt, options);
  return code;
}

/**
 * The watermark only advances after a real, complete run: advancing after a
 * simulation or a failure would hide items that never reached the target.
 */
async function advanceWatermark(
  deps: CommandDeps,
  identifier: string,
  lastSyncedAt: string,
  options: SyncOptions,
): Promise<void> {
  if (options.dryRun === true || options.yes !== true) {
    deps.logger.info('Watermark NOT advanced: this was a simulation.');
    return;
  }
  if (deps.syncState === undefined) return;

  await deps.syncState.write({ version: 1, identifier, lastSyncedAt });
  deps.logger.info(`Watermark advanced to ${lastSyncedAt}.`);
}

async function applyPlan(
  deps: CommandDeps,
  plan: MigrationPlan,
  options: ApplyOptions,
): Promise<number> {
  if (hasBlockingErrors(plan)) {
    // A dedicated message instead of letting MigrationBlockedError surface: the
    // operator needs to know WHERE to read the details.
    await writeText(artifactPath(options.outDir, 'report'), renderPlanReport(plan));
    deps.logger.error(
      `${symbol.error} Plan blocked by ${String(
        plan.findings.filter((finding) => finding.severity === 'error').length,
      )} error(s). Details in ${artifactPath(options.outDir, 'report')}.`,
    );
    return EXIT.problems;
  }

  const dryRun = options.dryRun === true || options.yes !== true;
  if (dryRun && options.dryRun !== true) {
    deps.logger.warn(
      'Running as a SIMULATION because --yes was not provided; nothing will be written to the target.',
    );
  }

  const executor = new Executor(
    deps.target,
    deps.store,
    deps.logger,
    deps.attachments,
    deps.sleeper,
  );

  const progress =
    options.progress === true ? new ProgressLine(dryRun ? 'Simulating' : 'Applying') : null;

  let result: ExecutionResult;
  try {
    result = await executor.execute(plan, {
      dryRun,
      retry: toRetryPolicy(deps.config),
      concurrency: deps.config.execution.concurrency,
      ...(progress === null
        ? {}
        : {
            onProgress: ({ done, total, failures }) => {
              progress.update(done, total, failures);
            },
          }),
    });
  } catch (error: unknown) {
    if (error instanceof MigrationBlockedError) {
      deps.logger.error(`${symbol.error} ${error.message}`);
      return EXIT.problems;
    }
    throw error;
  } finally {
    progress?.done();
  }

  await writeJson(artifactPath(options.outDir, 'execution'), result);
  await writeText(artifactPath(options.outDir, 'report'), renderExecutionReport(plan, result));

  summarizeExecution(deps, result, options.outDir);
  return result.failed.length > 0 ? EXIT.problems : EXIT.ok;
}

/** Re-renders the report from the artifacts on disk, with no network access. */
export async function runReport(
  deps: CommandDeps,
  options: ArtifactOptions & { plan?: string; execution?: string; out?: string },
): Promise<number> {
  const plan = await readPlan(options.plan ?? artifactPath(options.outDir, 'plan'));
  const executionPath = options.execution ?? artifactPath(options.outDir, 'execution');
  const target = options.out ?? artifactPath(options.outDir, 'report');

  const execution = await tryReadExecution(executionPath);
  const content =
    execution === null ? renderPlanReport(plan) : renderExecutionReport(plan, execution);

  await writeText(target, content);
  deps.logger.info(
    `${symbol.ok} ${execution === null ? 'Plan' : 'Execution'} report written to ${target}.`,
  );
  return EXIT.ok;
}

/**
 * Lists the source → target map.
 *
 * It is called `ledger` and not `rollback` because Jira cannot cleanly undo
 * issue creation: the real value of this record is idempotency and
 * reconciliation, not undoing. Calling it "rollback" would lead the operator to
 * expect something the target API does not deliver.
 */
export async function runLedger(deps: CommandDeps, options: { json?: boolean }): Promise<number> {
  const entries = await deps.store.list();
  const write = deps.write ?? ((text: string) => process.stdout.write(text));

  if (options.json === true) {
    write(`${JSON.stringify(entries, null, 2)}\n`);
    return EXIT.ok;
  }

  if (entries.length === 0) {
    // Goes to stdout: silence plus exit 0 would be ambiguous for a query.
    write('(ledger is empty: nothing has been migrated yet)\n');
    return EXIT.ok;
  }

  for (const entry of entries) {
    write(`${entry.sourceId} ${color.dim(symbol.arrow)} ${entry.targetRef.humanRef}\n`);
  }
  deps.logger.info(`${formatNumber(entries.length)} mapping(s) in the ledger.`);
  return EXIT.ok;
}

async function preparePlan(
  deps: CommandDeps,
  options: ArtifactOptions & { snapshot?: string; since?: string },
): Promise<MigrationPlan> {
  const model =
    options.snapshot === undefined
      ? await extractModel(deps, options.since)
      : await readSnapshot(options.snapshot);

  const projectKey = deps.config.target.projectKey;
  deps.logger.info(`Discovering target capabilities (${projectKey})…`);
  const capabilities = await deps.target.discoverCapabilities(projectKey);

  return buildPlan(model, capabilities, toMappingConfig(deps.config), projectKey, {
    generatedAt: deps.clock.now(),
  });
}

async function extractModel(deps: CommandDeps, since?: string): Promise<IssueModel> {
  const options = toExtractOptions(deps.config, since);
  deps.logger.info(`Extracting ${options.identifier} from ${deps.source.platformName}…`);
  const model = await deps.source.extract(options);
  deps.logger.info(`Extracted ${formatNumber(model.issues.length)} issue(s).`);
  return model;
}

function summarizePlan(deps: CommandDeps, plan: MigrationPlan, outDir: string): void {
  const errors = plan.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = plan.findings.filter((finding) => finding.severity === 'warning').length;

  deps.logger.info(
    `Plan: ${formatNumber(plan.actions.length)} action(s) for project ${plan.targetProjectKey}.`,
  );

  if (errors > 0) {
    deps.logger.error(
      `${symbol.error} ${String(errors)} error(s) block apply. See ${artifactPath(outDir, 'report')}.`,
    );
  } else {
    deps.logger.info(`${symbol.ok} No blocking errors.`);
  }
  if (warnings > 0) deps.logger.warn(`${String(warnings)} warning(s) in the plan.`);
}

function summarizeExecution(deps: CommandDeps, result: ExecutionResult, outDir: string): void {
  const mode = result.dryRun ? 'Simulation' : 'Execution';
  deps.logger.info(
    `${mode} finished: ${formatNumber(result.succeeded.length)} ok, ` +
      `${formatNumber(result.skipped.length)} skipped, ${formatNumber(result.failed.length)} failed.`,
  );

  if (result.failed.length > 0) {
    deps.logger.error(
      `${symbol.error} Failure details in ${artifactPath(outDir, 'report')}. ` +
        'Re-running is safe: the ledger skips whatever already exists.',
    );
  }
}

async function tryReadExecution(filePath: string): Promise<ExecutionResult | null> {
  try {
    return await readExecution(filePath);
  } catch {
    // Missing is normal: `report` between `analyze` and `apply`.
    return null;
  }
}

function countComments(model: IssueModel): number {
  return model.issues.reduce((total, issue) => total + issue.comments.length, 0);
}

function countAttachments(model: IssueModel): number {
  return model.issues.reduce(
    (total, issue) =>
      total +
      issue.attachments.length +
      issue.comments.reduce((sum, comment) => sum + comment.attachments.length, 0),
    0,
  );
}
