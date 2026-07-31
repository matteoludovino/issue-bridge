import { describe, expect, it } from 'vitest';
import { GitHubSourceAdapter } from './adapters/github/github-source-adapter.js';
import type { HttpClient, HttpRequest, HttpResponse } from './adapters/http.js';
import { JiraTargetAdapter } from './adapters/jira/jira-target-adapter.js';
import { Executor } from './core/executor/executor.js';
import { InMemoryRollbackStore } from './core/executor/in-memory-rollback-store.js';
import { hasBlockingErrors } from './core/models/migration-plan.js';
import { buildPlan } from './core/planner/planner.js';
import {
  FakeAttachmentFetcher,
  FakeTargetAdapter,
  RecordingLogger,
  makeCapabilities,
  makeMappingConfig,
} from './core/testing/fixtures.js';

/**
 * Integração das Fases 3 e 4: extract (GitHub) → buildPlan → Executor.
 * Sem rede: HTTP falso na origem, adapter falso no destino.
 */

const PAYLOAD: Record<string, unknown> = {
  '/issues?': [
    {
      number: 1,
      title: 'Épico: novo checkout',
      body: '- [ ] #2\n- [x] Levantar requisitos',
      state: 'open',
      labels: [{ name: 'epic' }],
      user: { login: 'ana', id: 10, html_url: 'https://github.com/ana' },
      assignees: [],
      milestone: {
        number: 3,
        title: 'Sprint 3',
        state: 'open',
        html_url: 'https://github.com/acme/api/milestone/3',
      },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      html_url: 'https://github.com/acme/api/issues/1',
      comments: 1,
    },
    {
      number: 2,
      title: 'Corrigir cálculo de frete',
      body: 'Relates to #1\n\n![erro.png](https://user-images.githubusercontent.com/1/erro.png)',
      state: 'closed',
      closed_at: '2026-02-01T00:00:00Z',
      labels: [{ name: 'bug' }, { name: 'p1' }],
      user: { login: 'bruno', id: 20, html_url: 'https://github.com/bruno' },
      assignees: [{ login: 'carla', id: 30, html_url: 'https://github.com/carla' }],
      created_at: '2026-01-03T00:00:00Z',
      updated_at: '2026-01-04T00:00:00Z',
      html_url: 'https://github.com/acme/api/issues/2',
      comments: 0,
    },
  ],
  '/issues/1/comments': [
    {
      id: 555,
      body: 'alinhado com o time',
      user: { login: 'carla', id: 30, html_url: 'https://github.com/carla' },
      created_at: '2026-01-05T00:00:00Z',
      html_url: 'https://github.com/acme/api/issues/1#issuecomment-555',
    },
  ],
  '/labels': [{ name: 'epic' }, { name: 'bug' }, { name: 'p1' }],
  '/milestones': [
    {
      number: 3,
      title: 'Sprint 3',
      state: 'open',
      html_url: 'https://github.com/acme/api/milestone/3',
    },
  ],
};

class StubHttpClient implements HttpClient {
  send(request: HttpRequest): Promise<HttpResponse> {
    const match = Object.keys(PAYLOAD).find((pattern) => request.url.includes(pattern));
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(match === undefined ? [] : PAYLOAD[match]),
    });
  }
}

/** Jira falso: `POST /issue` devolve chaves incrementais para as asserções valerem. */
class StubJiraClient implements HttpClient {
  readonly sent: HttpRequest[] = [];
  private issueCounter = 0;

  send(request: HttpRequest): Promise<HttpResponse> {
    this.sent.push(request);
    const ok = (payload: unknown): Promise<HttpResponse> =>
      Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(payload) });

    if (request.url.includes('/rest/api/3/project/ENG/statuses')) {
      return ok([
        {
          id: '1',
          name: 'Task',
          statuses: [
            { id: '1', name: 'To Do' },
            { id: '2', name: 'Done' },
          ],
        },
      ]);
    }
    if (request.url.includes('/issuetypes/')) {
      return ok({
        fields: [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }],
      });
    }
    if (request.url.includes('/issuetypes?')) {
      return ok({
        issueTypes: [
          { id: '10001', name: 'Task', subtask: false },
          { id: '10002', name: 'Epic', subtask: false },
        ],
      });
    }
    if (request.url.includes('/rest/api/3/priority')) return ok([{ id: '1', name: 'Medium' }]);
    if (request.url.includes('/rest/api/3/label')) return ok({ values: [] });
    if (request.url.includes('/rest/api/3/project/ENG')) {
      return ok({ id: '10000', key: 'ENG', name: 'Engenharia', components: [], versions: [] });
    }
    if (request.url.includes('/transitions')) {
      return request.method === 'GET'
        ? ok({ transitions: [{ id: '31', name: 'Finish', to: { id: '2', name: 'Done' } }] })
        : Promise.resolve({ status: 204, headers: {}, body: '' });
    }
    if (request.url.includes('/attachments')) return ok([{ id: '900', filename: 'erro.png' }]);
    if (request.url.includes('/comment')) return ok({ id: '800' });
    if (request.url.includes('/issueLink')) {
      return Promise.resolve({ status: 201, headers: {}, body: '' });
    }
    if (request.url.includes('/rest/api/3/issue')) {
      this.issueCounter += 1;
      const id = String(10_500 + this.issueCounter);
      return ok({ id, key: `ENG-${String(this.issueCounter)}` });
    }
    return Promise.resolve({ status: 404, headers: {}, body: '{"errorMessages":["sem rota"]}' });
  }

  postedFields(): Record<string, unknown>[] {
    return this.sent
      .filter(
        (request) =>
          request.method === 'POST' &&
          /\/rest\/api\/3\/issue$/.test(request.url) &&
          typeof request.body === 'string',
      )
      .map(
        (request) =>
          (JSON.parse(request.body as string) as { fields: Record<string, unknown> }).fields,
      );
  }
}

describe('pipeline extract → plan → execute', () => {
  it('migra um épico com subtarefa fechada, em dry-run e depois de verdade', async () => {
    const source = new GitHubSourceAdapter({
      token: 'ghp_test',
      httpClient: new StubHttpClient(),
      clock: { now: () => '2026-03-01T00:00:00Z' },
    });

    const model = await source.extract({ identifier: 'acme/api' });
    expect(model.issues.map((issue) => issue.type)).toEqual(['epic', 'bug']);
    // Task list `- [ ] #2` no épico virou hierarquia da issue #2.
    expect(model.issues[1]?.parentSourceRef?.id).toBe('github:acme/api:issue:1');

    const plan = buildPlan(
      model,
      makeCapabilities(),
      makeMappingConfig({ defaultPriority: 'medium' }),
      'ENG',
      { generatedAt: '2026-03-01T00:01:00Z' },
    );

    expect(hasBlockingErrors(plan)).toBe(false);
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'create_epic',
      // As 3 labels do repositório não existem no destino.
      'create_label',
      'create_label',
      'create_label',
      'create_issue',
      'create_issue',
      'create_comment',
      'create_attachment',
      'create_link',
      'transition_issue',
    ]);

    const target = new FakeTargetAdapter();
    const store = new InMemoryRollbackStore();
    const executor = new Executor(target, store, new RecordingLogger(), new FakeAttachmentFetcher());

    const simulated = await executor.execute(plan, { dryRun: true });
    expect(simulated.succeeded).toHaveLength(plan.actions.length);
    expect(target.calls).toEqual([]);
    expect(await store.list()).toEqual([]);

    const applied = await executor.execute(plan);
    expect(applied.failed).toEqual([]);
    expect(applied.succeeded).toHaveLength(plan.actions.length);
    expect(target.calls.map((call) => call.split(':')[0])).toEqual([
      'createEpic',
      'createLabel',
      'createLabel',
      'createLabel',
      'createIssue',
      'createIssue',
      'createComment',
      'createAttachment',
      'createLink',
      'transitionIssue',
    ]);

    // Reexecutar não escreve nada: o ledger cobre tudo.
    const rerun = await executor.execute(plan);
    expect(rerun.skipped).toHaveLength(plan.actions.length);
    expect(rerun.succeeded).toEqual([]);
  });

  it('roda contra o JiraTargetAdapter real, com capabilities descobertas do destino', async () => {
    const model = await new GitHubSourceAdapter({
      token: 'ghp_test',
      httpClient: new StubHttpClient(),
      clock: { now: () => '2026-03-01T00:00:00Z' },
    }).extract({ identifier: 'acme/api' });

    const jiraClient = new StubJiraClient();
    const jira = new JiraTargetAdapter({
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      apiToken: 'token',
      httpClient: jiraClient,
    });

    // Capabilities vêm do DESTINO, não de fixture: é o contrato da Fase 3.
    const capabilities = await jira.discoverCapabilities('ENG');
    expect(capabilities.issueTypes).toEqual(['Task', 'Epic']);
    expect(capabilities.workflow.statuses).toEqual(['To Do', 'Done']);

    const plan = buildPlan(
      model,
      capabilities,
      {
        issueTypes: {
          epic: 'Epic',
          story: 'Task',
          task: 'Task',
          bug: 'Task',
          subtask: 'Task',
        },
        priorities: {
          highest: 'Medium',
          high: 'Medium',
          medium: 'Medium',
          low: 'Medium',
          lowest: 'Medium',
        },
        statuses: { open: 'To Do', in_progress: 'To Do', closed: 'Done' },
        milestoneStrategy: 'epic',
      },
      'ENG',
      { generatedAt: '2026-03-01T00:01:00Z' },
    );

    expect(hasBlockingErrors(plan)).toBe(false);

    const result = await new Executor(
      jira,
      new InMemoryRollbackStore(),
      new RecordingLogger(),
      new FakeAttachmentFetcher(),
    ).execute(plan);

    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(plan.actions.length);

    // Épico + 2 issues foram criados como issues, com ADF no description.
    const posted = jiraClient.postedFields();
    expect(posted).toHaveLength(3);
    // [0] épico do milestone; [1] issue #1 (label `epic`), filha do épico;
    // [2] issue #2, filha de #1 via task list.
    expect(posted[0]).toMatchObject({ issuetype: { name: 'Epic' }, summary: 'Sprint 3' });
    expect(posted[1]).toMatchObject({
      issuetype: { name: 'Epic' },
      summary: 'Épico: novo checkout',
      parent: { id: '10501' },
    });
    expect(posted[1]?.['description']).toMatchObject({ type: 'doc', version: 1 });
    expect(posted[2]).toMatchObject({ issuetype: { name: 'Task' }, parent: { id: '10502' } });

    const paths = jiraClient.sent
      .filter((request) => request.method === 'POST')
      .map((request) => request.url.replace('https://acme.atlassian.net/rest/api/3', ''));
    expect(paths).toEqual([
      '/issue',
      '/issue',
      '/issue',
      '/issue/10502/comment',
      '/issue/10503/attachments',
      '/issueLink',
      '/issue/10503/transitions',
    ]);
  });
});
