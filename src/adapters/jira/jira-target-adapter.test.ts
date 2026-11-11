import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SourceRef } from '../../core/models/common.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { JiraTargetAdapter } from './jira-target-adapter.js';

/** Fake client: routes are matched by method + URL substring, in registration order. */
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
        body: '{"errorMessages":["route not registered"]}',
      });
    }
    return Promise.resolve(route.response);
  }

  /** JSON body of the first request that matches method + pattern. */
  bodyOf(method: string, pattern: string): Record<string, unknown> {
    const request = this.sent.find(
      (candidate) => candidate.method === method && candidate.url.includes(pattern),
    );
    if (request === undefined || typeof request.body !== 'string') {
      throw new Error(`no ${method} ${pattern} request with a JSON body`);
    }
    return JSON.parse(request.body) as Record<string, unknown>;
  }

  requestFor(method: string, pattern: string): HttpRequest {
    const request = this.sent.find(
      (candidate) => candidate.method === method && candidate.url.includes(pattern),
    );
    if (request === undefined) throw new Error(`no ${method} ${pattern} request`);
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
  it('validates credentials at /myself with Basic auth', async () => {
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

  it('maps 401 to a non-retryable auth error', async () => {
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
        // Most specific routes first: the project URL is a prefix of the others.
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
          name: 'Engineering',
          components: [{ id: '1', name: 'API' }],
          versions: [{ id: '2', name: 'v1.0' }],
        })
    );
  }

  it('builds the project snapshot from createmeta, priority, statuses and label', async () => {
    const capabilities = await adapterWith(capabilitiesClient()).discoverCapabilities('ENG');

    expect(capabilities.issueTypes).toEqual(['Task', 'Epic']);
    expect(capabilities.priorities).toEqual(['High', 'Medium']);
    expect(capabilities.components).toEqual(['API']);
    expect(capabilities.versions).toEqual(['v1.0']);
    expect(capabilities.labels).toEqual(['infra']);
    // Statuses deduplicated, workflow order preserved: [0] is the initial one.
    expect(capabilities.workflow.statuses).toEqual(['To Do', 'Done']);
    expect(capabilities.requiredFieldsByIssueType).toEqual({
      Task: ['summary', 'customfield_10042'],
      Epic: ['summary'],
    });
    expect(capabilities.customFields).toEqual([
      { id: 'customfield_10042', name: 'Severity', type: 'option' },
    ]);
  });

  it('declares optimistic transitions, because Jira does not expose the workflow without an issue', async () => {
    const capabilities = await adapterWith(capabilitiesClient()).discoverCapabilities('ENG');

    expect(capabilities.workflow.transitions).toEqual({
      'To Do': ['Done'],
      Done: ['To Do'],
    });
  });

  it('degrades to an empty label list when the endpoint denies access', async () => {
    const client = capabilitiesClient({
      status: 403,
      body: '{"errorMessages":["forbidden"]}',
    });

    const capabilities = await adapterWith(client).discoverCapabilities('ENG');

    // The whole discovery must not fail because of a secondary catalog.
    expect(capabilities.labels).toEqual([]);
    expect(capabilities.issueTypes).toEqual(['Task', 'Epic']);
  });
});

describe('JiraTargetAdapter — writes', () => {
  let client: FakeJiraClient;

  beforeEach(() => {
    client = new FakeJiraClient();
  });

  it('creates an issue with ADF, a sanitized label, a resolved assignee and a custom field', async () => {
    client
      .json('GET', '/user/search', [{ accountId: 'acc-123', emailAddress: 'ana@example.test' }])
      .json('POST', '/rest/api/3/issue', { id: '10500', key: 'ENG-5' });

    const ref = await adapterWith(client).createIssue({
      projectKey: 'ENG',
      issueType: 'Bug',
      summary: 'Login failure',
      description: 'Body with **bold**',
      priority: 'High',
      labels: ['needs review'],
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
    expect(fields['labels']).toEqual(['needs-review']);
    expect(fields['assignee']).toEqual({ id: 'acc-123' });
    expect(fields['customfield_10042']).toEqual({ value: 'Critical' });
    expect(fields['description']).toMatchObject({ type: 'doc', version: 1 });
  });

  it('keeps the issue when the assignee does not exist in the target', async () => {
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

  it('a direct parent takes precedence over the epic in the single Jira parent field', async () => {
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

  it('creates an epic as an issue of the configured type', async () => {
    client.json('POST', '/rest/api/3/issue', { id: '2', key: 'ENG-2' });

    await new JiraTargetAdapter({
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      apiToken: 'token',
      httpClient: client,
      epicIssueTypeName: 'Initiative',
    }).createEpic({ projectKey: 'ENG', name: 'Sprint 3', fields: {}, sourceRef });

    const fields = client.bodyOf('POST', '/rest/api/3/issue')['fields'] as Record<string, unknown>;
    expect(fields['issuetype']).toEqual({ name: 'Initiative' });
    expect(fields['summary']).toBe('Sprint 3');
  });

  it('createLabel is a no-op: it sends no request', async () => {
    const ref = await adapterWith(client).createLabel({ projectKey: 'ENG', name: 'infra' });

    expect(ref).toEqual({ id: 'infra', humanRef: 'infra' });
    expect(client.sent).toEqual([]);
  });

  it('creates a version with releaseDate in the format Jira accepts', async () => {
    client
      .json('GET', '/project/ENG', { id: '10000', key: 'ENG', name: 'Engineering' })
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

  it('creates a comment with an ADF body', async () => {
    client.json('POST', '/issue/10500/comment', { id: '900' });

    const ref = await adapterWith(client).createComment({
      issueRef: { id: '10500', humanRef: 'ENG-5' },
      body: '# Note\n\ntext',
      sourceRef,
    });

    expect(ref.id).toBe('900');
    const body = client.bodyOf('POST', '/comment')['body'] as Record<string, unknown>;
    expect(body['type']).toBe('doc');
    expect((body['content'] as unknown[]).length).toBe(2);
  });

  it('uploads an attachment as multipart with the XSRF token and the received bytes', async () => {
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

  it('creates a link with outward/inward direction and returns null', async () => {
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

  it('transitions using the id of the transition that leads to the requested status', async () => {
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

  it('fails listing the actual transitions when the status is not reachable', async () => {
    client.json('GET', '/transitions', {
      transitions: [{ id: '21', name: 'Start', to: { id: '2', name: 'In Progress' } }],
    });

    await expect(
      adapterWith(client).transitionIssue({ id: '10500', humanRef: 'ENG-5' }, 'Done'),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('Available: In Progress'),
    });
  });

  it('keeps the rejected field when Jira responds 400', async () => {
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
