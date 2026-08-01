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
 * Comandos da CLI.
 *
 * Cada função recebe as dependências já construídas e devolve o código de saída
 * — nada aqui sabe que a origem é GitHub ou o destino é Jira, e nada aqui chama
 * `process.exit`. É o que torna os comandos testáveis com adapters falsos.
 */

export const EXIT = {
  /** Tudo certo. */
  ok: 0,
  /** Executou, mas há erro bloqueante no plano ou falha de ação. */
  problems: 1,
  /** Não foi possível executar: config, credencial ou artefato inválido. */
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
  /** Marca d'água do `sync`. Ausente, `sync` roda sempre completo. */
  syncState?: SyncStateStore;
  sleeper?: Sleeper;
  /** Saída de DADOS (stdout). Log humano vai para stderr, via `logger`. */
  write?: (text: string) => void;
}

export interface ArtifactOptions {
  outDir: string;
}

/** Valida as duas credenciais antes de qualquer trabalho pesado. */
export async function runLogin(deps: CommandDeps): Promise<number> {
  await deps.source.authenticate();
  deps.logger.info(`${symbol.ok} Credencial da origem (${deps.source.platformName}) válida.`);

  await deps.target.authenticate();
  deps.logger.info(`${symbol.ok} Credencial do destino (${deps.target.platformName}) válida.`);

  return EXIT.ok;
}

/** Extrai a origem para um snapshot em disco, sem tocar no destino. */
export async function runExport(
  deps: CommandDeps,
  options: ArtifactOptions & { out?: string },
): Promise<number> {
  const model = await extractModel(deps);
  const target = options.out ?? artifactPath(options.outDir, 'snapshot');

  await writeJson(target, model);
  deps.logger.info(
    `${symbol.ok} Snapshot gravado em ${target}: ${formatNumber(model.issues.length)} issue(s), ` +
      `${formatNumber(countComments(model))} comentário(s), ${formatNumber(countAttachments(model))} anexo(s).`,
  );
  return EXIT.ok;
}

/**
 * Constrói e grava o plano sem escrever no destino. Código de saída 1 quando há
 * erro bloqueante — o que permite usar `analyze` como gate em CI.
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
  /** Plano já gerado pelo `analyze`; ausente, é construído agora. */
  plan?: string;
  dryRun?: boolean;
  /** Sem isso, `apply` roda em simulação — escrever no destino é irreversível. */
  yes?: boolean;
  /** Linha de progresso no stderr. Só a CLI liga; por padrão fica silencioso. */
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
  /** Sobrescreve a marca d'água (ISO 8601). */
  since?: string;
  /** Ignora a marca d'água e relê a origem inteira. */
  full?: boolean;
}

/**
 * Migração incremental: lê da origem apenas o que mudou desde o último `sync`
 * bem-sucedido, aplica, e só então avança a marca d'água.
 *
 * A marca gravada é o instante de INÍCIO da extração. Se um item for alterado
 * durante a execução, ele cai na próxima janela em vez de ser perdido — o custo
 * é reprocessar alguns itens, que a idempotência do ledger absorve.
 *
 * Limite conhecido: `sync` traz itens NOVOS (issues, comentários, transições de
 * status). Alteração de título ou corpo de item já migrado não é propagada — o
 * plano não tem ação de atualização.
 */
export async function runSync(deps: CommandDeps, options: SyncOptions): Promise<number> {
  const identifier = deps.config.source.identifier;
  const state = options.full === true ? null : ((await deps.syncState?.read(identifier)) ?? null);
  const since = options.since ?? state?.lastSyncedAt;

  // Capturado ANTES da extração, de propósito.
  const startedAt = deps.clock.now();

  deps.logger.info(
    since === undefined
      ? `Sync completo de ${identifier} (sem marca d'água anterior).`
      : `Sync incremental de ${identifier}: alterações desde ${since}.`,
  );

  const plan = await preparePlan(deps, { ...options, ...(since === undefined ? {} : { since }) });

  if (plan.actions.length === 0) {
    deps.logger.info(`${symbol.ok} Nada novo na origem.`);
    await advanceWatermark(deps, identifier, startedAt, options);
    return EXIT.ok;
  }

  const code = await applyPlan(deps, plan, options);
  if (code === EXIT.ok) await advanceWatermark(deps, identifier, startedAt, options);
  return code;
}

/**
 * A marca só avança quando a execução foi real e completa: em simulação ou com
 * falha, avançar esconderia itens que nunca chegaram ao destino.
 */
async function advanceWatermark(
  deps: CommandDeps,
  identifier: string,
  lastSyncedAt: string,
  options: SyncOptions,
): Promise<void> {
  if (options.dryRun === true || options.yes !== true) {
    deps.logger.info('Marca d’água NÃO avançou: execução foi simulação.');
    return;
  }
  if (deps.syncState === undefined) return;

  await deps.syncState.write({ version: 1, identifier, lastSyncedAt });
  deps.logger.info(`Marca d’água avançada para ${lastSyncedAt}.`);
}

async function applyPlan(
  deps: CommandDeps,
  plan: MigrationPlan,
  options: ApplyOptions,
): Promise<number> {
  if (hasBlockingErrors(plan)) {
    // Mensagem própria em vez de deixar o MigrationBlockedError vazar: o
    // operador precisa saber ONDE ver o detalhe.
    await writeText(artifactPath(options.outDir, 'report'), renderPlanReport(plan));
    deps.logger.error(
      `${symbol.error} Plano bloqueado por ${String(
        plan.findings.filter((finding) => finding.severity === 'error').length,
      )} erro(s). Detalhes em ${artifactPath(options.outDir, 'report')}.`,
    );
    return EXIT.problems;
  }

  const dryRun = options.dryRun === true || options.yes !== true;
  if (dryRun && options.dryRun !== true) {
    deps.logger.warn(
      'Rodando em SIMULAÇÃO porque --yes não foi informado; nada será escrito no destino.',
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
    options.progress === true ? new ProgressLine(dryRun ? 'Simulando' : 'Aplicando') : null;

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

/** Regera o relatório a partir dos artefatos, sem rede. */
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
    `${symbol.ok} Relatório ${execution === null ? 'do plano' : 'da execução'} gravado em ${target}.`,
  );
  return EXIT.ok;
}

/**
 * Lista o mapa origem → destino.
 *
 * Chama-se `ledger`, e não `rollback`, porque o Jira não desfaz criação de issue
 * de forma limpa: o valor real deste registro é idempotência e reconciliação,
 * não desfazer. Assumir "rollback" levaria o operador a esperar algo que a API
 * do destino não entrega.
 */
export async function runLedger(deps: CommandDeps, options: { json?: boolean }): Promise<number> {
  const entries = await deps.store.list();
  const write = deps.write ?? ((text: string) => process.stdout.write(text));

  if (options.json === true) {
    write(`${JSON.stringify(entries, null, 2)}\n`);
    return EXIT.ok;
  }

  if (entries.length === 0) {
    // Vai para o stdout: silêncio com código 0 seria ambíguo para quem consulta.
    write('(ledger vazio: nada foi migrado ainda)\n');
    return EXIT.ok;
  }

  for (const entry of entries) {
    write(`${entry.sourceId} ${color.dim(symbol.arrow)} ${entry.targetRef.humanRef}\n`);
  }
  deps.logger.info(`${formatNumber(entries.length)} correspondência(s) no ledger.`);
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
  deps.logger.info(`Descobrindo capacidades do destino (${projectKey})…`);
  const capabilities = await deps.target.discoverCapabilities(projectKey);

  return buildPlan(model, capabilities, toMappingConfig(deps.config), projectKey, {
    generatedAt: deps.clock.now(),
  });
}

async function extractModel(deps: CommandDeps, since?: string): Promise<IssueModel> {
  const options = toExtractOptions(deps.config, since);
  deps.logger.info(`Extraindo ${options.identifier} de ${deps.source.platformName}…`);
  const model = await deps.source.extract(options);
  deps.logger.info(`Extraídas ${formatNumber(model.issues.length)} issue(s).`);
  return model;
}

function summarizePlan(deps: CommandDeps, plan: MigrationPlan, outDir: string): void {
  const errors = plan.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = plan.findings.filter((finding) => finding.severity === 'warning').length;

  deps.logger.info(
    `Plano: ${formatNumber(plan.actions.length)} ação(ões) para o projeto ${plan.targetProjectKey}.`,
  );

  if (errors > 0) {
    deps.logger.error(
      `${symbol.error} ${String(errors)} erro(s) bloqueiam o apply. Veja ${artifactPath(outDir, 'report')}.`,
    );
  } else {
    deps.logger.info(`${symbol.ok} Nenhum erro bloqueante.`);
  }
  if (warnings > 0) deps.logger.warn(`${String(warnings)} aviso(s) no plano.`);
}

function summarizeExecution(deps: CommandDeps, result: ExecutionResult, outDir: string): void {
  const mode = result.dryRun ? 'Simulação' : 'Execução';
  deps.logger.info(
    `${mode} concluída: ${formatNumber(result.succeeded.length)} ok, ` +
      `${formatNumber(result.skipped.length)} pulada(s), ${formatNumber(result.failed.length)} falha(s).`,
  );

  if (result.failed.length > 0) {
    deps.logger.error(
      `${symbol.error} Falhas detalhadas em ${artifactPath(outDir, 'report')}. ` +
        'Reexecutar é seguro: o ledger pula o que já foi criado.',
    );
  }
}

async function tryReadExecution(filePath: string): Promise<ExecutionResult | null> {
  try {
    return await readExecution(filePath);
  } catch {
    // Ausente é normal: `report` depois de `analyze` e antes de `apply`.
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
