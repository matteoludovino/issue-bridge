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

/** Logger mínimo. Implementação real (Pino) fica na camada de infraestrutura. */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RollbackEntry {
  /** Chave de idempotência (ver `storeKeyFor`). */
  sourceId: string;
  targetRef: TargetItemRef;
}

/**
 * Ledger de correspondência origem → destino.
 *
 * Serve a três propósitos, nessa ordem: idempotência (o Executor consulta antes
 * de criar), `sync` (resolve para onde escrever atualizações) e `rollback`
 * (lista o que foi criado, para remoção best-effort). A implementação durável
 * (JSON/SQLite) vem em fase posterior.
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
  /** `null` quando o destino não devolve referência (alguns tipos de link). */
  targetRef: TargetItemRef | null;
  /** Tentativas gastas (1 = sem retry). `0` em dry-run. */
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

/** Política de retry. Aplica-se só a `MigrationError` com `retryable: true`. */
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
   * Percorre resolução de dependências e idempotência exatamente como uma
   * execução real, mas nunca chama métodos de criação do `TargetAdapter`.
   * É o que dá suporte ao `analyze` sem duplicar a lógica de ordenação.
   */
  dryRun?: boolean;
  /** Sobrescreve `DEFAULT_RETRY_POLICY` (vem da config em produção). */
  retry?: RetryPolicy;
  /**
   * Chamado depois de cada ação. Existe para a CLI mostrar progresso real sem
   * inferir estado a partir de mensagens de log.
   */
  onProgress?: (progress: { done: number; total: number; failures: number }) => void;
  /**
   * Ações independentes executadas em paralelo. O padrão é 1 (sequencial, na
   * ordem do plano) para que o comportamento de biblioteca seja determinístico;
   * a CLI passa o valor da config.
   */
  concurrency?: number;
}

/** Lançado quando o plano tem findings `error`. Nada é executado. */
export class MigrationBlockedError extends Error {
  readonly findings: PlanFinding[];

  constructor(findings: PlanFinding[]) {
    const blocking = findings.filter((finding) => finding.severity === 'error');
    super(
      `Plano bloqueado por ${String(blocking.length)} erro(s): ${blocking
        .map((finding) => `${finding.code} — ${finding.message}`)
        .join('; ')}`,
    );
    this.name = 'MigrationBlockedError';
    this.findings = blocking;
  }
}

/**
 * Chave de idempotência de uma ação no RollbackStore.
 *
 * Ações que criam uma entidade com identidade própria na origem são indexadas
 * pelo `sourceRef.id` — é isso que permite `sync` e resolução de dependências
 * entre execuções. Ações sem entidade própria (label, componente, link,
 * transição) usam o id da ação, que já é determinístico; sem isso, uma
 * `transition_issue` colidiria com a `create_issue` da mesma issue e seria
 * pulada indevidamente.
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

/** Referências de destino já resolvidas para uma ação. */
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
     * Obrigatório apenas quando o plano tem `create_attachment`. Ausente, essas
     * ações falham individualmente — o resto da migração segue.
     */
    private readonly attachments?: AttachmentFetcher,
    /** Injetável para que os testes de backoff não gastem tempo real. */
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

    this.logger.info('Iniciando execução do plano', {
      generatedAt: plan.generatedAt,
      actions: plan.actions.length,
      concurrency,
      dryRun,
    });

    await this.schedule({
      plan,
      result,
      actionById: new Map(plan.actions.map((action) => [action.id, action])),
      // Cache intra-execução; em dry-run é o único registro, já que nada é gravado.
      resolved: new Map<string, TargetItemRef>(),
      dryRun,
      retry,
      concurrency,
      onProgress: opts.onProgress,
    });

    // Resultados voltam para a ordem do PLANO, não a de conclusão: relatório,
    // diffs e testes precisam ser determinísticos mesmo com paralelismo.
    const inPlanOrder = <T extends { action: PlanAction }>(items: T[]): T[] =>
      [...items].sort(
        (left, right) =>
          (planIndex.get(left.action.id) ?? 0) - (planIndex.get(right.action.id) ?? 0),
      );
    result.succeeded = inPlanOrder(result.succeeded);
    result.skipped = inPlanOrder(result.skipped);
    result.failed = inPlanOrder(result.failed);

    result.finishedAt = new Date().toISOString();
    this.logger.info('Execução finalizada', {
      succeeded: result.succeeded.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    });
    return result;
  }

  /**
   * Escalonador com dependências.
   *
   * Uma ação entra em execução quando todo `dependsOn` já concluiu. Se alguma
   * dependência falhou, a ação é marcada como falha na hora — sem gastar
   * tentativa numa referência que nunca vai existir. Com `concurrency: 1` o
   * comportamento é idêntico ao laço sequencial, na ordem do plano.
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
      this.logger.error('Ação não executada', { actionId: action.id, message });
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

        // `splice` desloca a fila, então o índice não avança.
        queue.splice(index, 1);

        if (readiness === 'blocked') {
          fail(action, `Dependência de "${action.id}" falhou; a ação foi descartada.`);
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
        // Nada pronto e nada rodando: só acontece se `dependsOn` aponta para
        // fora do plano. Falhar explicitamente é melhor que travar.
        for (const action of queue) {
          fail(action, `Ação "${action.id}" depende de algo que não existe no plano.`);
        }
        break;
      }

      await Promise.race(inFlight.values());
    }
  }

  /** Corpo de uma ação: idempotência, dependências, escrita e registro. */
  private async runAction(action: PlanAction, context: ScheduleContext): Promise<'ok' | 'fail'> {
    const { plan, result, resolved, actionById, dryRun, retry } = context;
    const key = storeKeyFor(action);

    const existing = await this.store.get(key);
    if (existing !== null) {
      resolved.set(action.id, existing);
      result.skipped.push({ action, reason: 'skipped_already_migrated', targetRef: existing });
      this.logger.info('Ação já migrada, pulando', {
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
      this.logger.info(dryRun ? 'Ação simulada' : 'Ação concluída', {
        actionId: action.id,
        kind: action.kind,
        attempts,
        targetRef: targetRef?.humanRef,
      });
      return 'ok';
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      result.failed.push({ action, error: normalized, attempts: Math.max(attempts, 1) });
      this.logger.error('Ação falhou', {
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
   * Executa a ação com retry exponencial, apenas para erro classificado como
   * retentável pelo adapter (`rate-limit`, `transient`). Erro de validação ou
   * permissão falha na primeira tentativa — retentar não mudaria o resultado.
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
        this.logger.warn('Falha retentável; aguardando antes de repetir', {
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
   * Traduz ids de ação (`epicActionId`, `issueActionId`, `dependsOn`) em
   * `TargetItemRef` reais, via cache da execução ou via RollbackStore (permite
   * retomar uma migração interrompida).
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
          message: `Ação "${action.id}" referencia "${actionRefId}", que não existe no plano.`,
        });
      }

      const stored = await this.store.get(storeKeyFor(referenced));
      if (stored === null) {
        throw new MigrationError({
          code: 'validation',
          message: `Dependência "${actionRefId}" de "${action.id}" não foi criada (falhou ou foi pulada).`,
        });
      }
      resolved.set(actionRefId, stored);
      return stored;
    };

    // `dependsOn` é a rede de segurança: garante que nada rode antes do que
    // precisa, mesmo que a ação não use a referência diretamente.
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
            message: `Ação "${action.id}" exige um AttachmentFetcher, e o Executor foi construído sem um.`,
          });
        }
        // O download acontece AQUI, não no adapter de destino: só a origem tem a
        // credencial capaz de baixar o arquivo.
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
        // Destinos que não devolvem referência de link ainda precisam de marca de
        // idempotência, senão o link é recriado a cada execução.
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

/** `waiting` = dependência ainda rodando; `blocked` = dependência falhou. */
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
    message: `Ação "${action.id}" não teve suas dependências resolvidas.`,
  });
}

/**
 * Backoff exponencial determinístico (sem jitter, para o resultado ser
 * reproduzível). `retryAfterMs` do servidor NÃO é limitado por `maxDelayMs`:
 * quando o destino diz quanto esperar, ignorar isso só queima tentativas.
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
