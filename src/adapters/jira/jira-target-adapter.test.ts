import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SourceRef } from '../../core/models/common.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { JiraTargetAdapter } from './jira-target-adapter.js';

/** Cliente falso: rotas casadas por método + substring de URL, na ordem registrada. */
class FakeJiraClient implements HttpClient {
  readonly sent: HttpRequest[] = [];
  private readonly routes: { method: string; pattern: string; response: HttpResponse }[] = [];

  route(method: string, pattern: string, status: number, body: string): this {
    this.routes.push({ method, pattern, response: { status, headers: {}, body } });
    return this;
  }

  json(method: string, pattern: string, payload: unknown): this {
    return this.route(method, pattern, 200, JSON.stringify(payload));
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.sent.push(request);
    const route = this.routes.find(
      (candidate) => candidate.method === request.method && request.url.includes(candidate.pattern),
    );
    if (route === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: '{"errorMessages":["rota não registrada"]}',
      });
    }
    return Promise.resolve(route.response);
  }

  /** Corpo JSON da primeira requisição que casa com método + padrão. */
  bodyOf(method: string, pattern: string): Record<string, unknown> {
    const request = this.sent.find(
      (candidate) => candidate.method === method && candidate.url.includes(pattern),
    );
    if (request === undefined || typeof request.body !== 'string') {
      throw new Error(`nenhuma requisição ${method} ${pattern} com corpo JSON`);
    }
    return JSON.parse(request.body) as Record<string, unknown>;
  }

  requestFor(method: string, pattern: string): HttpRequest {
    const request = this.sent.find(
      (candidate) => candidate.method === method && candidate.url.includes(pattern),
    );
    if (request === undefined) throw new Error(`nenhuma requisição ${method} ${pattern}`);
    return request;
  }
}

const sourceRef: SourceRef = {
  platform: 'github',
  id: 'github:acme/api:issue:1',
  humanRef: '#1',
  url: 'https://github.com/acme/api/issues/1',
};

function adapterWith(client: FakeJiraClient): JiraTargetAdapter {
  return new JiraTargetAdapter({
    baseUrl: 'https://acme.atlassian.net',
    email: 'bot@acme.com',
    apiToken: 'token',
    httpClient: client,
  });
}

describe('JiraTargetAdapter.authenticate', () => {
  it('valida credencial em /myself com Basic auth', async () => {
    const client = new FakeJiraClient().json('GET', '/myself', {
      accountId: 'abc',
      displayName: 'Bot',
    });

    await adapterWith(client).authenticate();

    const request = client.requestFor('GET', '/myself');
    expect(request.headers['authorization']).toBe(
      `Basic ${Buffer.from('bot@acme.com:token').toString('base64')}`,
    );
  });

  it('traduz 401 para erro de auth não-retentável', async () => {
    const client = new FakeJiraClient().route('GET', '/myself', 401, '{"errorMessages":["nope"]}');

    await expect(adapterWith(client).authenticate()).rejects.toMatchObject({
      code: 'auth',
      retryable: false,
    });
  });
});

describe('JiraTargetAdapter.discoverCapabilities', () => {
  function capabilitiesClient(
    labels: { status: number; body: string } = { status: 200, body: '{"values":["infra"]}' },
  ): FakeJiraClient {
    return (
      new FakeJiraClient()
        // Rotas mais específicas primeiro: a URL do projeto é prefixo das outras.
        .json('GET', '/project/ENG/statuses', [
          {
            id: '10001',
            name: 'Task',
            statuses: [
              { id: '1', name: 'To Do' },
              { id: '2', name: 'Done' },
            ],
          },
          { id: '10002', name: 'Epic', statuses: [{ id: '1', name: 'To Do' }] },
        ])
        .json('GET', '/issuetypes/10001', {
          fields: [
            { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
            {
              fieldId: 'customfield_10042',
              name: 'Severity',
              required: true,
              schema: { type: 'option', custom: 'com.atlassian.jira.plugin:select' },
            },
          ],
        })
        .json('GET', '/issuetypes/10002', {
          fields: [
            { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
          ],
        })
        .json('GET', '/issuetypes?', {
          issueTypes: [
            { id: '10001', name: 'Task', subtask: false },
            { id: '10002', name: 'Epic', subtask: false },
          ],
        })
        .json('GET', '/rest/api/3/priority', [
          { id: '1', name: 'High' },
          { id: '2', name: 'Medium' },
        ])
        .route('GET', '/rest/api/3/label', labels.status, labels.body)
        .json('GET', '/project/ENG', {
          id: '10000',
          key: 'ENG',
          name: 'Engenharia',
          components: [{ id: '1', name: 'API' }],
          versions: [{ id: '2', name: 'v1.0' }],
        })
    );
  }

  it('monta o retrato do projeto a partir de createmeta, priority, statuses e label', async () => {
    const capabilities = await adapterWith(capabilitiesClient()).discoverCapabilities('ENG');

    expect(capabilities.issueTypes).toEqual(['Task', 'Epic']);
    expect(capabilities.priorities).toEqual(['High', 'Medium']);
    expect(capabilities.components).toEqual(['API']);
    expect(capabilities.versions).toEqual(['v1.0']);
    expect(capabilities.labels).toEqual(['infra']);
    // Status deduplicado, ordem de workflow preservada: [0] é o inicial.
    expect(capabilities.workflow.statuses).toEqual(['To Do', 'Done']);
    expect(capabilities.requiredFieldsByIssueType).toEqual({
      Task: ['summary', 'customfield_10042'],
      Epic: ['summary'],
    });
    expect(capabilities.customFields).toEqual([
      { id: 'customfield_10042', name: 'Severity', type: 'option' },
    ]);
  });

  it('declara transições otimistas, porque o Jira não expõe o workflow sem issue', async () => {
    const capabilities = await adapterWith(capabilitiesClient()).discoverCapabilities('ENG');

    expect(capabilities.workflow.transitions).toEqual({
      'To Do': ['Done'],
      Done: ['To Do'],
    });
  });

  it('degrada para lista de labels vazia quando o endpoint nega acesso', async () => {
    const client = capabilitiesClient({
      status: 403,
      body: '{"errorMessages":["forbidden"]}',
    });

    const capabilities = await adapterWith(client).discoverCapabilities('ENG');

    // A descoberta inteira não pode cair por causa de um catálogo secundário.
    expect(capabilities.labels).toEqual([]);
    expect(capabilities.issueTypes).toEqual(['Task', 'Epic']);
  });
});

describe('JiraTargetAdapter — escrita', () => {
  let client: FakeJiraClient;

  beforeEach(() => {
    client = new FakeJiraClient();
  });

  it('cria issue com ADF, label sanitizada, assignee resolvido e custom field', async () => {
    client
      .json('GET', '/user/search', [{ accountId: 'acc-123', emailAddress: 'ana@example.test' }])
      .json('POST', '/rest/api/3/issue', { id: '10500', key: 'ENG-5' });

    const ref = await adapterWith(client).createIssue({
      projectKey: 'ENG',
      issueType: 'Bug',
      summary: 'Falha no login',
      description: 'Corpo com **negrito**',
      priority: 'High',
      labels: ['precisa revisão'],
      assignees: ['ana@example.test'],
      fields: { customfield_10042: { value: 'Critical' } },
      sourceRef,
    });

    expect(ref).toEqual({
      id: '10500',
      humanRef: 'ENG-5',
      url: 'https://acme.atlassian.net/browse/ENG-5',
    });

    const fields = client.bodyOf('POST', '/rest/api/3/issue')['fields'] as Record<string, unknown>;
    expect(fields['project']).toEqual({ key: 'ENG' });
    expect(fields['issuetype']).toEqual({ name: 'Bug' });
    expect(fields['priority']).toEqual({ name: 'High' });
    expect(fields['labels']).toEqual(['precisa-revisão']);
    expect(fields['assignee']).toEqual({ id: 'acc-123' });
    expect(fields['customfield_10042']).toEqual({ value: 'Critical' });
    expect(fields['description']).toMatchObject({ type: 'doc', version: 1 });
  });

  it('mantém a issue quando o assignee não existe no destino', async () => {
    client
      .json('GET', '/user/search', [])
      .json('POST', '/rest/api/3/issue', { id: '1', key: 'ENG-1' });

    await adapterWith(client).createIssue({
      projectKey: 'ENG',
      issueType: 'Task',
      summary: 'x',
      description: '',
      labels: [],
      assignees: ['octocat'],
      fields: {},
      sourceRef,
    });

    const fields = client.bodyOf('POST', '/rest/api/3/issue')['fields'] as Record<string, unknown>;
    expect(fields['assignee']).toBeUndefined();
  });

  it('pai direto prevalece sobre épico no único campo parent do Jira', async () => {
    client.json('POST', '/rest/api/3/issue', { id: '1', key: 'ENG-1' });

    await adapterWith(client).createIssue({
      projectKey: 'ENG',
      issueType: 'Sub-task',
      summary: 'x',
      description: '',
      labels: [],
      assignees: [],
      fields: {},
      sourceRef,
      epicRef: { id: '9000', humanRef: 'ENG-90' },
      parentRef: { id: '8000', humanRef: 'ENG-80' },
    });

    const fields = client.bodyOf('POST', '/rest/api/3/issue')['fields'] as Record<string, unknown>;
    expect(fields['parent']).toEqual({ id: '8000' });
  });

  it('cria épico como issue do tipo configurado', async () => {
    client.json('POST', '/rest/api/3/issue', { id: '2', key: 'ENG-2' });

    await new JiraTargetAdapter({
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      apiToken: 'token',
      httpClient: client,
      epicIssueTypeName: 'Iniciativa',
    }).createEpic({ projectKey: 'ENG', name: 'Sprint 3', fields: {}, sourceRef });

    const fields = client.bodyOf('POST', '/rest/api/3/issue')['fields'] as Record<string, unknown>;
    expect(fields['issuetype']).toEqual({ name: 'Iniciativa' });
    expect(fields['summary']).toBe('Sprint 3');
  });

  it('createLabel é no-op: não faz requisição', async () => {
    const ref = await adapterWith(client).createLabel({ projectKey: 'ENG', name: 'infra' });

    expect(ref).toEqual({ id: 'infra', humanRef: 'infra' });
    expect(client.sent).toEqual([]);
  });

  it('cria versão com releaseDate no formato aceito pelo Jira', async () => {
    client
      .json('GET', '/project/ENG', { id: '10000', key: 'ENG', name: 'Engenharia' })
      .json('POST', '/rest/api/3/version', { id: '77', name: 'v1.2' });

    await adapterWith(client).createVersion({
      projectKey: 'ENG',
      name: 'v1.2',
      releaseDate: '2026-03-31T23:59:59Z',
      sourceRef,
    });

    expect(client.bodyOf('POST', '/rest/api/3/version')).toEqual({
      name: 'v1.2',
      projectId: 10000,
      releaseDate: '2026-03-31',
    });
  });

  it('cria comentário com corpo em ADF', async () => {
    client.json('POST', '/issue/10500/comment', { id: '900' });

    const ref = await adapterWith(client).createComment({
      issueRef: { id: '10500', humanRef: 'ENG-5' },
      body: '# Nota\n\ntexto',
      sourceRef,
    });

    expect(ref.id).toBe('900');
    const body = client.bodyOf('POST', '/comment')['body'] as Record<string, unknown>;
    expect(body['type']).toBe('doc');
    expect((body['content'] as unknown[]).length).toBe(2);
  });

  it('sobe anexo como multipart com o token XSRF e os bytes recebidos', async () => {
    client.json('POST', '/attachments', [{ id: '901', filename: 'print.png' }]);

    const ref = await adapterWith(client).createAttachment({
      issueRef: { id: '10500', humanRef: 'ENG-5' },
      payload: {
        filename: 'print.png',
        contentType: 'image/png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
      sourceUrl: 'https://user-images.githubusercontent.com/1/print.png',
      sourceRef,
    });

    expect(ref).toEqual({ id: '901', humanRef: 'print.png' });

    const request = client.requestFor('POST', '/attachments');
    expect(request.headers['x-atlassian-token']).toBe('no-check');
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const raw = request.body;
    expect(raw).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(raw as Uint8Array);
    expect(text).toContain('filename="print.png"');
    expect(text).toContain('Content-Type: image/png');
  });

  it('cria link com direção outward/inward e devolve null', async () => {
    client.route('POST', '/issueLink', 201, '');

    const result = await adapterWith(client).createLink({
      fromRef: { id: '1', humanRef: 'ENG-1' },
      toRef: { id: '2', humanRef: 'ENG-2' },
      linkType: 'blocks',
    });

    expect(result).toBeNull();
    expect(client.bodyOf('POST', '/issueLink')).toEqual({
      type: { name: 'Blocks' },
      outwardIssue: { id: '1' },
      inwardIssue: { id: '2' },
    });
  });

  it('transiciona pelo id da transição que leva ao status pedido', async () => {
    client
      .json('GET', '/transitions', {
        transitions: [
          { id: '21', name: 'Start', to: { id: '2', name: 'In Progress' } },
          { id: '31', name: 'Finish', to: { id: '3', name: 'Done' } },
        ],
      })
      .route('POST', '/transitions', 204, '');

    await adapterWith(client).transitionIssue({ id: '10500', humanRef: 'ENG-5' }, 'Done');

    expect(client.bodyOf('POST', '/transitions')).toEqual({ transition: { id: '31' } });
  });

  it('falha listando as transições reais quando o status não é alcançável', async () => {
    client.json('GET', '/transitions', {
      transitions: [{ id: '21', name: 'Start', to: { id: '2', name: 'In Progress' } }],
    });

    await expect(
      adapterWith(client).transitionIssue({ id: '10500', humanRef: 'ENG-5' }, 'Done'),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('Disponíveis: In Progress'),
    });
  });

  it('preserva o campo reprovado quando o Jira responde 400', async () => {
    client.route(
      'POST',
      '/rest/api/3/issue',
      400,
      '{"errorMessages":[],"errors":{"customfield_10042":"Severity is required."}}',
    );

    const error = await adapterWith(client)
      .createIssue({
        projectKey: 'ENG',
        issueType: 'Bug',
        summary: 'x',
        description: '',
        labels: [],
        assignees: [],
        fields: {},
        sourceRef,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'validation', retryable: false });
    expect((error as Error).message).toContain('customfield_10042: Severity is required.');
  });
});
