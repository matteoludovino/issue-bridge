#!/usr/bin/env node
import { Command } from 'commander';
import {
  createAttachmentFetcher,
  createRollbackStore,
  createSourceAdapter,
  createSyncStateStore,
  createTargetAdapter,
} from '../composition.js';
import { loadConfig } from '../config/loader.js';
import { isMigrationError } from '../core/errors.js';
import { ConsoleLogger, type LogLevel } from '../utils/logger.js';
import { color, symbol } from '../utils/ui.js';
import {
  EXIT,
  runAnalyze,
  runApply,
  runExport,
  runLedger,
  runLogin,
  runReport,
  runSync,
  type CommandDeps,
} from './commands.js';

/**
 * Thin layer: argument parsing, dependency construction and translation of an
 * error into an exit code. No business logic.
 *
 * Exit codes: 0 success · 1 the plan has an error or an action failed · 2 aborted
 * (invalid config, credentials or artifact).
 */

interface GlobalOptions {
  config: string;
  outDir: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}

async function buildDeps(globals: GlobalOptions): Promise<CommandDeps> {
  const logger = new ConsoleLogger({
    level: resolveLevel(globals),
    json: globals.json === true,
  });

  const loaded = await loadConfig(globals.config, process.env);

  return {
    config: loaded.config,
    source: createSourceAdapter(loaded),
    target: createTargetAdapter(loaded, logger),
    store: await createRollbackStore(loaded),
    attachments: createAttachmentFetcher(loaded),
    syncState: createSyncStateStore(loaded),
    logger,
    clock: { now: () => new Date().toISOString() },
  };
}

const globalsOf = (program: Command): GlobalOptions => program.opts<GlobalOptions>();

function resolveLevel(globals: GlobalOptions): LogLevel {
  if (globals.quiet === true) return 'error';
  if (globals.verbose === true) return 'info';
  // Default: hide the executor's per-action log (which can be thousands of
  // lines) and let the progress line plus the summary speak.
  return 'warn';
}

function main(): void {
  const program = new Command();

  program
    .name('issue-bridge')
    .description('Migrate issues between trackers (GitHub → Jira) with a reviewable plan, a ledger and a report.')
    .version('0.1.0')
    .option('-c, --config <file>', 'YAML configuration file', 'issue-bridge.yaml')
    .option('-o, --out-dir <dir>', 'where to write snapshot, plan and report', '.issue-bridge')
    .option('-v, --verbose', 'log every action')
    .option('-q, --quiet', 'errors only')
    .option('--json', 'log as JSON (one line per event)');

  const run = (
    handler: (deps: CommandDeps, options: Record<string, unknown>) => Promise<number>,
  ) => {
    return async (commandOptions: Record<string, unknown>): Promise<void> => {
      const globals = program.opts<GlobalOptions>();
      let code: number;
      try {
        const deps = await buildDeps(globals);
        code = await handler(deps, { ...commandOptions, outDir: globals.outDir });
      } catch (error: unknown) {
        code = reportFatal(error, globals.verbose === true);
      }
      process.exitCode = code;
    };
  };

  program
    .command('login')
    .description('validate the source and target credentials')
    .action(run(async (deps) => runLogin(deps)));

  program
    .command('export')
    .description('extract the source into a local snapshot, without touching the target')
    .option('--out <file>', 'snapshot path')
    .action(
      run(async (deps, options) =>
        runExport(deps, {
          outDir: options['outDir'] as string,
          ...(typeof options['out'] === 'string' ? { out: options['out'] } : {}),
        }),
      ),
    );

  program
    .command('analyze')
    .description('build the plan and report without writing to the target (exits 1 on error)')
    .option('--snapshot <file>', 'use an already extracted snapshot instead of calling the source')
    .action(
      run(async (deps, options) =>
        runAnalyze(deps, {
          outDir: options['outDir'] as string,
          ...(typeof options['snapshot'] === 'string' ? { snapshot: options['snapshot'] } : {}),
        }),
      ),
    );

  program
    .command('apply')
    .description('execute the plan against the target; without --yes it simulates')
    .option('--plan <file>', 'plan already produced by analyze')
    .option('--dry-run', 'simulate explicitly')
    .option('--yes', 'confirm real writes to the target')
    .action(
      run(async (deps, options) =>
        runApply(deps, {
          outDir: options['outDir'] as string,
          // A progress line only makes sense in human output.
          progress: globalsOf(program).json !== true && globalsOf(program).quiet !== true,
          ...(typeof options['plan'] === 'string' ? { plan: options['plan'] } : {}),
          ...(options['dryRun'] === true ? { dryRun: true } : {}),
          ...(options['yes'] === true ? { yes: true } : {}),
        }),
      ),
    );

  program
    .command('sync')
    .description('migrate only what changed since the last sync; without --yes it simulates')
    .option('--since <iso>', 'override the watermark (e.g. 2026-03-01T00:00:00Z)')
    .option('--full', 'ignore the watermark and re-read the whole source')
    .option('--dry-run', 'simulate explicitly')
    .option('--yes', 'confirm real writes to the target')
    .action(
      run(async (deps, options) =>
        runSync(deps, {
          outDir: options['outDir'] as string,
          progress: globalsOf(program).json !== true && globalsOf(program).quiet !== true,
          ...(typeof options['since'] === 'string' ? { since: options['since'] } : {}),
          ...(options['full'] === true ? { full: true } : {}),
          ...(options['dryRun'] === true ? { dryRun: true } : {}),
          ...(options['yes'] === true ? { yes: true } : {}),
        }),
      ),
    );

  program
    .command('report')
    .description('re-render the report from the plan and the execution log')
    .option('--plan <file>', 'plan to use')
    .option('--execution <file>', 'execution log to use')
    .option('--out <file>', 'report path')
    .action(
      run(async (deps, options) =>
        runReport(deps, {
          outDir: options['outDir'] as string,
          ...(typeof options['plan'] === 'string' ? { plan: options['plan'] } : {}),
          ...(typeof options['execution'] === 'string'
            ? { execution: options['execution'] }
            : {}),
          ...(typeof options['out'] === 'string' ? { out: options['out'] } : {}),
        }),
      ),
    );

  program
    .command('ledger')
    .description('list the source → target map (idempotency and reconciliation)')
    .option('--json', 'print the ledger as JSON on stdout')
    .action(
      run(async (deps, options) =>
        // The global `--json` and the command's own are the same flag as far as
        // commander is concerned: accepting both keeps `ledger --json` from
        // falling through to the human output.
        runLedger(deps, {
          json: options['json'] === true || globalsOf(program).json === true,
        }),
      ),
    );

  program.parse();
}

/** An expected error becomes an actionable message; anything else shows the stack. */
function reportFatal(error: unknown, verbose: boolean): number {
  if (isMigrationError(error)) {
    process.stderr.write(`${color.red(symbol.error)} ${error.message}\n`);
    if (error.code === 'rate-limit' && error.retryAfterMs !== undefined) {
      process.stderr.write(
        `  Try again in ~${String(Math.ceil(error.retryAfterMs / 1000))}s.\n`,
      );
    }
    return error.code === 'validation' || error.code === 'auth' || error.code === 'not-found'
      ? EXIT.aborted
      : EXIT.problems;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${color.red(symbol.error)} Unexpected error: ${message}\n`);
  if (verbose && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${color.dim(error.stack)}\n`);
  }
  return EXIT.aborted;
}

main();
