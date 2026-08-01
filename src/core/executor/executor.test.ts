import { beforeEach, describe, expect, it } from 'vitest';
import { MigrationError } from '../errors.js';
import type { MigrationPlan } from '../models/migration-plan.js';
import { buildPlan } from '../planner/planner.js';
import {
  FakeAttachmentFetcher,
  FakeTargetAdapter,
  RecordingLogger,
  RecordingSleeper,
  makeCapabilities,
  makeComment,
  makeIssue,
  makeMappingConfig,
  makeMilestone,
  makeModel,
  ref,
} from '../testing/fixtures.js';
import { Executor, MigrationBlockedError, storeKeyFor } from './executor.js';
import { InMemoryRollbackStore } from './in-memory-rollback-store.js';

const options = { generatedAt: '2026-02-01T12:00:00Z' };

/** Épico + issue pai (com comentário e link) + subtask fechada (com anexo). */
function scenarioPlan(): MigrationPlan {
  const milestone = makeMilestone('m1', 'Sprint 1');
  const parent = makeIssue({
    id: '1',
    milestone: milestone.sourceRef,
    comments: [makeComment('c1')],
    links: [{ type: 'relates_to', targetSourceRef: ref('issue', '2') }],
  });
  const child = makeIssue({
    id: '2',
    type: 'subtask',
    status: 'closed',
    parentSourceRef: parent.sourceRef,
    attachments: [
      {
        sourceRef: ref('attachment', 'a1'),
        filename: 'print.png',
        url: 'https://example.test/print.png',
        origin: 'api',
      },
    ],
  });

  return buildPlan(
    makeModel({ milestones: [milestone], issues: [parent, child] }),
    makeCapabilities(),
    makeMappingConfig(),
    'ENG',
    options,
  );
}

const methodsCalled = (adapter: FakeTargetAdapter): string[] =>
  adapter.calls.map((call) => call.split(':')[0] ?? call);

describe('Executor', () => {
  let adapter: FakeTargetAdapter;
  let store: InMemoryRollbackStore;
  let logger: RecordingLogger;
  let fetcher: FakeAttachmentFetcher;
  let sleeper: RecordingSleeper;
  let executor: Executor;

  beforeEach(() => {
    adapter = new FakeTargetAdapter();
    store = new InMemoryRollbackStore();
    logger = new RecordingLogger();
    fetcher = new FakeAttachmentFetcher();
    sleeper = new RecordingSleeper();
    executor = new Executor(adapter, store, logger, fetcher, sleeper);
  });

  it('recusa plano com findings de erro e não escreve nada', async () => {
    const plan = buildPlan(
      makeModel({ issues: [makeIssue({ id: '1', type: 'bug' })] }),
      makeCapabilities(),
      makeMappingConfig({
        issueTypes: {
          epic: 'Epic',
          story: 'Story',
          task: 'Task',
          bug: 'Defect',
          subtask: 'Sub-task',
        },
      }),
      'ENG',
      options,
    );

    await expect(executor.execute(plan)).rejects.toThrow(MigrationBlockedError);
    expect(adapter.calls).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('executa na ordem do plano e persiste cada item criado', async () => {
    const plan = scenarioPlan();
    const result = await executor.execute(plan);

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.succeeded).toHaveLength(plan.actions.length);
    expect(methodsCalled(adapter)).toEqual([
      'createEpic',
      'createIssue',
      'createIssue',
      'createComment',
      'createAttachment',
      'createLink',
      'transitionIssue',
    ]);

    // Todo item criado tem correspondência no ledger.
    const entries = await store.list();
    expect(entries).toHaveLength(plan.actions.length);
    for (const action of plan.actions) {
      expect(await store.get(storeKeyFor(action))).not.toBeNull();
    }
  });

  it('resolve dependências para as referências reais do destino', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan);

    const issueRef = await store.get('fake:acme/api:issue:1');
    expect(issueRef).not.toBeNull();
    // O comentário foi criado apontando para a issue criada, não para o id de origem.
    expect(adapter.calls).toContain(
      `createComment:fake:acme/api:comment:c1@${String(issueRef?.id)}`,
    );
  });

  it('é idempotente: pula o que já está no ledger e reaproveita a referência', async () => {
    const existing = { id: 'ENG-99', humanRef: 'ENG-99' };
    store = new InMemoryRollbackStore([
      { sourceId: 'fake:acme/api:issue:1', targetRef: existing },
    ]);
    executor = new Executor(adapter, store, logger, fetcher);

    const plan = scenarioPlan();
    const result = await executor.execute(plan);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('skipped_already_migrated');
    expect(result.skipped[0]?.action.id).toBe('issue:fake:acme/api:issue:1');
    expect(result.failed).toEqual([]);

    // A issue #1 não foi recriada, mas seu comentário usou a referência do ledger.
    expect(adapter.calls).not.toContain('createIssue:fake:acme/api:issue:1');
    expect(adapter.calls).toContain('createComment:fake:acme/api:comment:c1@ENG-99');
  });

  it('não confunde transição com criação da mesma issue (chaves distintas)', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan);

    const transition = plan.actions.find((action) => action.kind === 'transition_issue');
    expect(transition).toBeDefined();
    expect(storeKeyFor(transition!)).not.toBe('fake:acme/api:issue:2');
    expect(methodsCalled(adapter)).toContain('transitionIssue');

    // Segunda execução: tudo já está no ledger, nada é reescrito.
    const rerun = await executor.execute(plan);
    expect(rerun.skipped).toHaveLength(plan.actions.length);
    expect(rerun.succeeded).toEqual([]);
    expect(methodsCalled(adapter).filter((method) => method === 'transitionIssue')).toHaveLength(1);
  });

  it('dry-run percorre tudo sem chamar o destino nem gravar no ledger', async () => {
    const plan = scenarioPlan();
    const result = await executor.execute(plan, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.succeeded).toHaveLength(plan.actions.length);
    expect(result.failed).toEqual([]);
    expect(adapter.calls).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(result.succeeded[0]?.targetRef?.id).toMatch(/^dry-run:/);
  });

  it('isola falhas: um erro não impede as demais ações', async () => {
    // Duas issues independentes, cada uma com um comentário.
    const plan = buildPlan(
      makeModel({
        issues: [
          makeIssue({ id: '1', comments: [makeComment('c1')] }),
          makeIssue({ id: '2', comments: [makeComment('c2')] }),
        ],
      }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );
    adapter.failingSourceIds.add('fake:acme/api:issue:1');

    const result = await executor.execute(plan);

    const failedIds = result.failed.map((failure) => failure.action.id);
    // A issue #1 falhou e seu comentário ficou sem dependência resolvida...
    expect(failedIds).toEqual([
      'issue:fake:acme/api:issue:1',
      'comment:fake:acme/api:comment:c1',
    ]);
    // ...mas a issue #2 e o comentário dela seguiram normalmente.
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual([
      'issue:fake:acme/api:issue:2',
      'comment:fake:acme/api:comment:c2',
    ]);
    expect(
      result.failed.find((failure) => failure.action.kind === 'create_issue')?.error,
    ).toMatchObject({ code: 'validation', retryable: false });
    // Falha não-retentável: uma tentativa só, sem espera.
    expect(sleeper.delays).toEqual([]);
    // O dependente é bloqueado pelo escalonador, antes de qualquer chamada.
    expect(
      result.failed.find((failure) => failure.action.kind === 'create_comment')?.error.message,
    ).toContain('Dependência de');
    expect(logger.errors).toHaveLength(2);
  });

  it('interrompe a cadeia quando o pai falha, sem afetar issues independentes', async () => {
    const plan = scenarioPlan();
    adapter.failingSourceIds.add('fake:acme/api:issue:1');

    const result = await executor.execute(plan);

    const failedIds = result.failed.map((failure) => failure.action.id);
    // Subtask, anexo, link e transição dependem da issue #1 que falhou.
    expect(failedIds).toEqual([
      'issue:fake:acme/api:issue:1',
      'issue:fake:acme/api:issue:2',
      'comment:fake:acme/api:comment:c1',
      'attachment:fake:acme/api:attachment:a1',
      'link:fake:acme/api:issue:1|relates_to|fake:acme/api:issue:2',
      // O status de destino faz parte do id: é o que permite o `sync` aplicar
      // uma nova transição na mesma issue.
      'transition:fake:acme/api:issue:2:Done',
    ]);
    // O épico não dependia de nada e foi criado.
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual([
      'epic:fake:acme/api:milestone:m1',
    ]);
  });

  it('baixa o anexo pela origem e entrega bytes ao destino', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan);

    expect(fetcher.requested).toEqual(['https://example.test/print.png']);
    expect(adapter.uploadedBytes).toEqual([4]);
  });

  it('sem AttachmentFetcher, só a ação de anexo falha', async () => {
    const semFetcher = new Executor(adapter, store, logger, undefined, sleeper);
    const plan = scenarioPlan();

    const result = await semFetcher.execute(plan);

    expect(result.failed.map((failure) => failure.action.kind)).toEqual(['create_attachment']);
    expect(result.failed[0]?.error.message).toContain('AttachmentFetcher');
    expect(result.succeeded).toHaveLength(plan.actions.length - 1);
  });

  it('retenta erro transitório com backoff exponencial e conclui', async () => {
    const plan = scenarioPlan();
    // Duas falhas transitórias no épico antes de dar certo.
    adapter.transientFailures.set('fake:acme/api:milestone:m1', 2);

    const result = await executor.execute(plan, {
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000 },
    });

    expect(result.failed).toEqual([]);
    expect(sleeper.delays).toEqual([100, 200]);
    expect(result.succeeded[0]).toMatchObject({ attempts: 3 });
    // As demais ações não gastaram tentativa extra.
    expect(result.succeeded[1]).toMatchObject({ attempts: 1 });
  });

  it('respeita retryAfterMs do destino em vez do backoff calculado', async () => {
    const plan = scenarioPlan();
    let calls = 0;
    const rateLimited = {
      ...adapter,
      platformName: 'fake-target',
      createEpic: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new MigrationError({
              code: 'rate-limit',
              message: 'devagar',
              retryAfterMs: 61_000,
            }),
          );
        }
        return Promise.resolve({ id: 'TGT-1', humanRef: 'TGT-1' });
      },
    } as unknown as FakeTargetAdapter;

    const result = await new Executor(rateLimited, store, logger, fetcher, sleeper).execute(plan, {
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    });

    // 61s > maxDelayMs, e ainda assim é respeitado: o servidor sabe melhor.
    expect(sleeper.delays[0]).toBe(61_000);
    expect(result.succeeded[0]).toMatchObject({ attempts: 2 });
  });

  it('desiste após maxAttempts e registra as tentativas gastas', async () => {
    const plan = scenarioPlan();
    adapter.transientFailures.set('fake:acme/api:milestone:m1', 99);

    const result = await executor.execute(plan, {
      retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
    });

    const failedEpic = result.failed.find((failure) => failure.action.kind === 'create_epic');
    expect(failedEpic).toMatchObject({ attempts: 3, error: { code: 'transient' } });
    // 3 tentativas = 2 esperas.
    expect(sleeper.delays).toEqual([50, 100]);

    // A issue #1 dependia do épico, então a cadeia toda cai — mas os dependentes
    // falham na primeira tentativa, sem gastar retry em dependência inexistente.
    expect(result.failed).toHaveLength(plan.actions.length);
    expect(
      result.failed
        .filter((failure) => failure.action.kind !== 'create_epic')
        .every((failure) => failure.attempts === 1),
    ).toBe(true);
  });

  it('reporta progresso após cada ação, incluindo falhas acumuladas', async () => {
    const plan = scenarioPlan();
    adapter.failingSourceIds.add('fake:acme/api:comment:c1');
    const events: string[] = [];

    await executor.execute(plan, {
      onProgress: ({ done, total, failures }) =>
        events.push(`${String(done)}/${String(total)}:${String(failures)}`),
    });

    expect(events).toHaveLength(plan.actions.length);
    expect(events[0]).toBe('1/7:0');
    // A 4ª ação é o comentário, que falha.
    expect(events[3]).toBe('4/7:1');
    expect(events.at(-1)).toBe('7/7:1');
  });

  it('com concurrency 1 mantém a ordem exata do plano', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan, { concurrency: 1 });

    expect(methodsCalled(adapter)).toEqual([
      'createEpic',
      'createIssue',
      'createIssue',
      'createComment',
      'createAttachment',
      'createLink',
      'transitionIssue',
    ]);
    expect(adapter.maxInFlight).toBe(1);
  });

  it('executa ações independentes em paralelo, respeitando dependências', async () => {
    // Duas issues irmãs, cada uma com comentário: os comentários dependem só da
    // própria issue, então há trabalho genuinamente paralelizável.
    const plan = buildPlan(
      makeModel({
        issues: [
          makeIssue({ id: '1', comments: [makeComment('c1')] }),
          makeIssue({ id: '2', comments: [makeComment('c2')] }),
          makeIssue({ id: '3', comments: [makeComment('c3')] }),
        ],
      }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    const result = await executor.execute(plan, { concurrency: 3 });

    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(6);
    // Prova de paralelismo: mais de uma chamada simultânea ao destino.
    expect(adapter.maxInFlight).toBeGreaterThan(1);
    expect(adapter.maxInFlight).toBeLessThanOrEqual(3);

    // Invariante que o paralelismo não pode violar: a issue existe antes do
    // comentário dela.
    for (const suffix of ['1', '2', '3']) {
      const issueAt = adapter.calls.findIndex((call) =>
        call.startsWith(`createIssue:fake:acme/api:issue:${suffix}`),
      );
      const commentAt = adapter.calls.findIndex((call) =>
        call.includes(`comment:c${suffix}@`),
      );
      expect(issueAt).toBeGreaterThanOrEqual(0);
      expect(commentAt).toBeGreaterThan(issueAt);
    }

    // Resultado volta na ordem do plano, não na de conclusão.
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual(
      plan.actions.map((action) => action.id),
    );
  });

  it('não começa o dependente antes do pai terminar, mesmo com folga de concorrência', async () => {
    const parent = makeIssue({ id: '1' });
    const child = makeIssue({ id: '2', parentSourceRef: parent.sourceRef, type: 'subtask' });
    const plan = buildPlan(
      makeModel({ issues: [parent, child] }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    // Segura a criação do pai; o filho não pode aparecer nas chamadas enquanto isso.
    let release = (): void => {};
    adapter.gates.set(
      'fake:acme/api:issue:1',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const execution = executor.execute(plan, { concurrency: 4 });
    // Drena a fila de microtasks: o executor faz vários `await` (ledger,
    // dependências) antes de chamar o destino.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adapter.calls).toEqual(['createIssue:fake:acme/api:issue:1']);

    release();
    const result = await execution;

    expect(result.failed).toEqual([]);
    expect(adapter.calls).toEqual([
      'createIssue:fake:acme/api:issue:1',
      'createIssue:fake:acme/api:issue:2',
    ]);
  });

  it('paralelismo não faz o dependente de uma falha gastar tentativa', async () => {
    const plan = buildPlan(
      makeModel({
        issues: [
          makeIssue({ id: '1', comments: [makeComment('c1')] }),
          makeIssue({ id: '2', comments: [makeComment('c2')] }),
        ],
      }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );
    adapter.failingSourceIds.add('fake:acme/api:issue:1');

    const result = await executor.execute(plan, { concurrency: 4 });

    expect(result.failed.map((failure) => failure.action.id)).toEqual([
      'issue:fake:acme/api:issue:1',
      'comment:fake:acme/api:comment:c1',
    ]);
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual([
      'issue:fake:acme/api:issue:2',
      'comment:fake:acme/api:comment:c2',
    ]);
    // O comentário órfão nunca chegou ao destino.
    expect(adapter.calls.some((call) => call.includes('comment:c1'))).toBe(false);
  });

  it('marca link no ledger mesmo quando o destino não devolve referência', async () => {
    adapter.linkReturnsNull = true;
    const plan = scenarioPlan();
    await executor.execute(plan);

    const link = plan.actions.find((action) => action.kind === 'create_link');
    expect(link).toBeDefined();
    expect(await store.get(storeKeyFor(link!))).toMatchObject({ id: link!.id });
  });
});
