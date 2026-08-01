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
 * Camada fina: parse de argumentos, construção das dependências e tradução de
 * erro em código de saída. Nenhuma regra de negócio.
 *
 * Códigos de saída: 0 sucesso · 1 há erro no plano ou falha de ação · 2 abortado
 * (config, credencial ou artefato inválido).
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
  // Padrão: esconde o log por ação do Executor (que pode ser milhares de linhas)
  // e deixa o progresso + resumo falarem.
  return 'warn';
}

function main(): void {
  const program = new Command();

  program
    .name('issue-bridge')
    .description('Migra issues entre trackers (GitHub → Jira) com plano, ledger e relatório.')
    .version('0.1.0')
    .option('-c, --config <arquivo>', 'arquivo de configuração YAML', 'issue-bridge.yaml')
    .option('-o, --out-dir <diretório>', 'onde gravar snapshot, plano e relatório', '.issue-bridge')
    .option('-v, --verbose', 'mostra o log de cada ação')
    .option('-q, --quiet', 'só erros')
    .option('--json', 'log em JSON (uma linha por evento)');

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
    .description('valida as credenciais de origem e destino')
    .action(run(async (deps) => runLogin(deps)));

  program
    .command('export')
    .description('extrai a origem para um snapshot local, sem tocar no destino')
    .option('--out <arquivo>', 'caminho do snapshot')
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
    .description('gera o plano e o relatório sem escrever no destino (sai 1 se houver erro)')
    .option('--snapshot <arquivo>', 'usa um snapshot já extraído em vez de chamar a origem')
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
    .description('executa o plano no destino; sem --yes roda em simulação')
    .option('--plan <arquivo>', 'plano já gerado pelo analyze')
    .option('--dry-run', 'simula explicitamente')
    .option('--yes', 'confirma a escrita real no destino')
    .action(
      run(async (deps, options) =>
        runApply(deps, {
          outDir: options['outDir'] as string,
          // Progresso só faz sentido em saída humana.
          progress: globalsOf(program).json !== true && globalsOf(program).quiet !== true,
          ...(typeof options['plan'] === 'string' ? { plan: options['plan'] } : {}),
          ...(options['dryRun'] === true ? { dryRun: true } : {}),
          ...(options['yes'] === true ? { yes: true } : {}),
        }),
      ),
    );

  program
    .command('sync')
    .description('migra só o que mudou desde o último sync; sem --yes roda em simulação')
    .option('--since <iso>', 'sobrescreve a marca d’água (ex.: 2026-03-01T00:00:00Z)')
    .option('--full', 'ignora a marca d’água e relê a origem inteira')
    .option('--dry-run', 'simula explicitamente')
    .option('--yes', 'confirma a escrita real no destino')
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
    .description('regera o relatório a partir do plano e do log de execução')
    .option('--plan <arquivo>', 'plano a usar')
    .option('--execution <arquivo>', 'log de execução a usar')
    .option('--out <arquivo>', 'caminho do relatório')
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
    .description('lista o mapa origem → destino (idempotência e reconciliação)')
    .option('--json', 'imprime o ledger em JSON no stdout')
    .action(
      run(async (deps, options) =>
        // O `--json` global e o do comando são o mesmo flag para o commander:
        // aceitar os dois evita que `ledger --json` caia na saída humana.
        runLedger(deps, {
          json: options['json'] === true || globalsOf(program).json === true,
        }),
      ),
    );

  program.parse();
}

/** Erro esperado vira mensagem acionável; inesperado mostra o stack. */
function reportFatal(error: unknown, verbose: boolean): number {
  if (isMigrationError(error)) {
    process.stderr.write(`${color.red(symbol.error)} ${error.message}\n`);
    if (error.code === 'rate-limit' && error.retryAfterMs !== undefined) {
      process.stderr.write(
        `  Tente novamente em ~${String(Math.ceil(error.retryAfterMs / 1000))}s.\n`,
      );
    }
    return error.code === 'validation' || error.code === 'auth' || error.code === 'not-found'
      ? EXIT.aborted
      : EXIT.problems;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${color.red(symbol.error)} Erro inesperado: ${message}\n`);
  if (verbose && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${color.dim(error.stack)}\n`);
  }
  return EXIT.aborted;
}

main();
