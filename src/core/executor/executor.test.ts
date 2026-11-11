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

/** Epic + parent issue (with a comment and a link) + closed subtask (with an attachment). */
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

  it('rejects a plan with error findings and writes nothing', async () => {
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

  it('runs in plan order and persists every created item', async () => {
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

    // Every created item has an entry in the ledger.
    const entries = await store.list();
    expect(entries).toHaveLength(plan.actions.length);
    for (const action of plan.actions) {
      expect(await store.get(storeKeyFor(action))).not.toBeNull();
    }
  });

  it('resolves dependencies to the actual target references', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan);

    const issueRef = await store.get('fake:acme/api:issue:1');
    expect(issueRef).not.toBeNull();
    // The comment was created pointing at the created issue, not at the source id.
    expect(adapter.calls).toContain(
      `createComment:fake:acme/api:comment:c1@${String(issueRef?.id)}`,
    );
  });

  it('is idempotent: skips what is already in the ledger and reuses the reference', async () => {
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

    // Issue #1 was not recreated, but its comment used the reference from the ledger.
    expect(adapter.calls).not.toContain('createIssue:fake:acme/api:issue:1');
    expect(adapter.calls).toContain('createComment:fake:acme/api:comment:c1@ENG-99');
  });

  it('does not confuse a transition with the creation of the same issue (distinct keys)', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan);

    const transition = plan.actions.find((action) => action.kind === 'transition_issue');
    expect(transition).toBeDefined();
    expect(storeKeyFor(transition!)).not.toBe('fake:acme/api:issue:2');
    expect(methodsCalled(adapter)).toContain('transitionIssue');

    // Second run: everything is already in the ledger, nothing is rewritten.
    const rerun = await executor.execute(plan);
    expect(rerun.skipped).toHaveLength(plan.actions.length);
    expect(rerun.succeeded).toEqual([]);
    expect(methodsCalled(adapter).filter((method) => method === 'transitionIssue')).toHaveLength(1);
  });

  it('dry-run walks through everything without calling the target or writing to the ledger', async () => {
    const plan = scenarioPlan();
    const result = await executor.execute(plan, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.succeeded).toHaveLength(plan.actions.length);
    expect(result.failed).toEqual([]);
    expect(adapter.calls).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(result.succeeded[0]?.targetRef?.id).toMatch(/^dry-run:/);
  });

  it('isolates failures: one error does not stop the other actions', async () => {
    // Two independent issues, each with one comment.
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
    // Issue #1 failed and its comment was left with an unresolved dependency...
    expect(failedIds).toEqual([
      'issue:fake:acme/api:issue:1',
      'comment:fake:acme/api:comment:c1',
    ]);
    // ...but issue #2 and its comment went through normally.
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual([
      'issue:fake:acme/api:issue:2',
      'comment:fake:acme/api:comment:c2',
    ]);
    expect(
      result.failed.find((failure) => failure.action.kind === 'create_issue')?.error,
    ).toMatchObject({ code: 'validation', retryable: false });
    // Non-retryable failure: a single attempt, no wait.
    expect(sleeper.delays).toEqual([]);
    // The dependent is blocked by the scheduler, before any call.
    expect(
      result.failed.find((failure) => failure.action.kind === 'create_comment')?.error.message,
    ).toContain('A dependency of');
    expect(logger.errors).toHaveLength(2);
  });

  it('stops the chain when the parent fails, without affecting independent issues', async () => {
    const plan = scenarioPlan();
    adapter.failingSourceIds.add('fake:acme/api:issue:1');

    const result = await executor.execute(plan);

    const failedIds = result.failed.map((failure) => failure.action.id);
    // Subtask, attachment, link and transition depend on the failed issue #1.
    expect(failedIds).toEqual([
      'issue:fake:acme/api:issue:1',
      'issue:fake:acme/api:issue:2',
      'comment:fake:acme/api:comment:c1',
      'attachment:fake:acme/api:attachment:a1',
      'link:fake:acme/api:issue:1|relates_to|fake:acme/api:issue:2',
      // The target status is part of the id: that is what lets `sync` apply
      // a new transition to the same issue.
      'transition:fake:acme/api:issue:2:Done',
    ]);
    // The epic depended on nothing and was created.
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual([
      'epic:fake:acme/api:milestone:m1',
    ]);
  });

  it('downloads the attachment through the source and hands bytes to the target', async () => {
    const plan = scenarioPlan();
    await executor.execute(plan);

    expect(fetcher.requested).toEqual(['https://example.test/print.png']);
    expect(adapter.uploadedBytes).toEqual([4]);
  });

  it('without an AttachmentFetcher, only the attachment action fails', async () => {
    const semFetcher = new Executor(adapter, store, logger, undefined, sleeper);
    const plan = scenarioPlan();

    const result = await semFetcher.execute(plan);

    expect(result.failed.map((failure) => failure.action.kind)).toEqual(['create_attachment']);
    expect(result.failed[0]?.error.message).toContain('AttachmentFetcher');
    expect(result.succeeded).toHaveLength(plan.actions.length - 1);
  });

  it('retries a transient error with exponential backoff and completes', async () => {
    const plan = scenarioPlan();
    // Two transient failures on the epic before it succeeds.
    adapter.transientFailures.set('fake:acme/api:milestone:m1', 2);

    const result = await executor.execute(plan, {
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000 },
    });

    expect(result.failed).toEqual([]);
    expect(sleeper.delays).toEqual([100, 200]);
    expect(result.succeeded[0]).toMatchObject({ attempts: 3 });
    // The other actions did not spend any extra attempt.
    expect(result.succeeded[1]).toMatchObject({ attempts: 1 });
  });

  it('honors retryAfterMs from the target instead of the computed backoff', async () => {
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

    // 61s > maxDelayMs, and it is still honored: the server knows better.
    expect(sleeper.delays[0]).toBe(61_000);
    expect(result.succeeded[0]).toMatchObject({ attempts: 2 });
  });

  it('gives up after maxAttempts and records the attempts used', async () => {
    const plan = scenarioPlan();
    adapter.transientFailures.set('fake:acme/api:milestone:m1', 99);

    const result = await executor.execute(plan, {
      retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
    });

    const failedEpic = result.failed.find((failure) => failure.action.kind === 'create_epic');
    expect(failedEpic).toMatchObject({ attempts: 3, error: { code: 'transient' } });
    // 3 attempts = 2 waits.
    expect(sleeper.delays).toEqual([50, 100]);

    // Issue #1 depended on the epic, so the whole chain fails — but the dependents
    // fail on the first attempt, without spending retries on a missing dependency.
    expect(result.failed).toHaveLength(plan.actions.length);
    expect(
      result.failed
        .filter((failure) => failure.action.kind !== 'create_epic')
        .every((failure) => failure.attempts === 1),
    ).toBe(true);
  });

  it('reports progress after each action, including accumulated failures', async () => {
    const plan = scenarioPlan();
    adapter.failingSourceIds.add('fake:acme/api:comment:c1');
    const events: string[] = [];

    await executor.execute(plan, {
      onProgress: ({ done, total, failures }) =>
        events.push(`${String(done)}/${String(total)}:${String(failures)}`),
    });

    expect(events).toHaveLength(plan.actions.length);
    expect(events[0]).toBe('1/7:0');
    // The 4th action is the comment, which fails.
    expect(events[3]).toBe('4/7:1');
    expect(events.at(-1)).toBe('7/7:1');
  });

  it('with concurrency 1 keeps the exact plan order', async () => {
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

  it('runs independent actions in parallel while respecting dependencies', async () => {
    // Two sibling issues, each with a comment: the comments depend only on
    // their own issue, so there is genuinely parallelizable work.
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
    // Proof of parallelism: more than one concurrent call to the target.
    expect(adapter.maxInFlight).toBeGreaterThan(1);
    expect(adapter.maxInFlight).toBeLessThanOrEqual(3);

    // Invariant parallelism must not violate: the issue exists before its
    // comment.
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

    // Results come back in plan order, not completion order.
    expect(result.succeeded.map((outcome) => outcome.action.id)).toEqual(
      plan.actions.map((action) => action.id),
    );
  });

  it('does not start the dependent before the parent finishes, even with spare concurrency', async () => {
    const parent = makeIssue({ id: '1' });
    const child = makeIssue({ id: '2', parentSourceRef: parent.sourceRef, type: 'subtask' });
    const plan = buildPlan(
      makeModel({ issues: [parent, child] }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    // Hold the parent's creation; the child must not show up in the calls meanwhile.
    let release = (): void => {};
    adapter.gates.set(
      'fake:acme/api:issue:1',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const execution = executor.execute(plan, { concurrency: 4 });
    // Drain the microtask queue: the executor does several `await`s (ledger,
    // dependencies) before calling the target.
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

  it('with parallelism, the dependent of a failure does not spend an attempt', async () => {
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
    // The orphaned comment never reached the target.
    expect(adapter.calls.some((call) => call.includes('comment:c1'))).toBe(false);
  });

  it('records the link in the ledger even when the target returns no reference', async () => {
    adapter.linkReturnsNull = true;
    const plan = scenarioPlan();
    await executor.execute(plan);

    const link = plan.actions.find((action) => action.kind === 'create_link');
    expect(link).toBeDefined();
    expect(await store.get(storeKeyFor(link!))).toMatchObject({ id: link!.id });
  });
});
