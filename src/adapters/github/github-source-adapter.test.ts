import { beforeEach, describe, expect, it } from 'vitest';
import { MigrationError } from '../../core/errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { GitHubSourceAdapter } from './github-source-adapter.js';

/**
 * Fake HTTP client: routes are matched by URL substring, in the order they were
 * registered. No network mocks, no dependency on `Response`.
 */
class FakeHttpClient implements HttpClient {
  readonly requests: string[] = [];
  private readonly routes: { pattern: string; response: HttpResponse }[] = [];

  on(pattern: string, response: HttpResponse): this {
    this.routes.push({ pattern, response });
    return this;
  }

  json(pattern: string, payload: unknown, headers: Record<string, string> = {}): this {
    return this.on(pattern, { status: 200, headers, body: JSON.stringify(payload) });
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request.url);
    const route = this.routes.find((candidate) => request.url.includes(candidate.pattern));
    if (route === undefined) {
      return Promise.resolve({ status: 404, headers: {}, body: '{"message":"Not Found"}' });
    }
    return Promise.resolve(route.response);
  }
}

const clock = { now: () => '2026-03-01T00:00:00Z' };

function rawIssue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Issue ${String(number)}`,
    body: '',
    state: 'open',
    labels: [],
    user: { login: 'ana', id: 10, html_url: 'https://github.com/ana' },
    assignees: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: `https://github.com/acme/api/issues/${String(number)}`,
    comments: 0,
    ...overrides,
  };
}

function adapterWith(client: FakeHttpClient): GitHubSourceAdapter {
  return new GitHubSourceAdapter({ token: 'ghp_test', httpClient: client, clock });
}

describe('GitHubSourceAdapter.authenticate', () => {
  it('validates the credentials against /user', async () => {
    const client = new FakeHttpClient().json('/user', { login: 'ana', id: 10 });
    await expect(adapterWith(client).authenticate()).resolves.toBeUndefined();
    expect(client.requests[0]).toContain('https://api.github.com/user');
  });

  it('maps 401 to an auth MigrationError, without retry', async () => {
    const client = new FakeHttpClient().on('/user', {
      status: 401,
      headers: {},
      body: '{"message":"Bad credentials"}',
    });

    await expect(adapterWith(client).authenticate()).rejects.toMatchObject({
      name: 'MigrationError',
      code: 'auth',
      retryable: false,
    });
  });
});

describe('GitHubSourceAdapter.extract', () => {
  let client: FakeHttpClient;

  beforeEach(() => {
    client = new FakeHttpClient();
  });

  it('paginates via the Link header, discards PRs and builds the IssueModel', async () => {
    client
      .json('/issues/1/comments', [
        {
          id: 555,
          body: 'first',
          user: { login: 'bruno', id: 20, html_url: 'https://github.com/bruno' },
          created_at: '2026-01-03T00:00:00Z',
          html_url: 'https://github.com/acme/api/issues/1#issuecomment-555',
        },
      ])
      .json('/labels', [{ name: 'bug', color: 'd73a4a', description: 'defect' }])
      .json('/milestones', [
        {
          number: 3,
          title: 'Sprint 3',
          state: 'open',
          due_on: '2026-04-01T00:00:00Z',
          html_url: 'https://github.com/acme/api/milestone/3',
        },
      ])
      .json(
        'page=2',
        [
          rawIssue(2, { body: '- [ ] #1' }),
          rawIssue(3, { pull_request: { url: 'https://api.github.com/pulls/3' } }),
        ],
      )
      .json('/issues?', [rawIssue(1, { comments: 1, labels: [{ name: 'bug' }] })], {
        link: '<https://api.github.com/repos/acme/api/issues?page=2>; rel="next"',
      });

    const model = await adapterWith(client).extract({ identifier: 'acme/api' });

    expect(model.source).toEqual({
      platform: 'github',
      identifier: 'acme/api',
      extractedAt: '2026-03-01T00:00:00Z',
    });
    // PR #3 was discarded.
    expect(model.issues.map((issue) => issue.sourceRef.humanRef)).toEqual(['#1', '#2']);
    expect(model.issues[0]?.type).toBe('bug');
    expect(model.issues[0]?.comments).toHaveLength(1);
    // Hierarchy: #2 declares `- [ ] #1`, so #1 gets a parentSourceRef.
    expect(model.issues[0]?.parentSourceRef?.id).toBe('github:acme/api:issue:2');
    expect(model.labels).toEqual([{ name: 'bug', color: 'd73a4a', description: 'defect' }]);
    expect(model.milestones[0]).toMatchObject({ title: 'Sprint 3', dueOn: '2026-04-01T00:00:00Z' });
  });

  it('only fetches comments for issues that have comments', async () => {
    client
      .json('/labels', [])
      .json('/milestones', [])
      .json('/issues?', [rawIssue(1), rawIssue(2)]);

    await adapterWith(client).extract({ identifier: 'acme/api' });

    expect(client.requests.some((url) => url.includes('/comments'))).toBe(false);
  });

  it('passes the state and label filters through in the query', async () => {
    client.json('/labels', []).json('/milestones', []).json('/issues?', []);

    await adapterWith(client).extract({
      identifier: 'acme/api',
      includeClosed: false,
      labelFilter: ['bug', 'p1'],
    });

    const issuesRequest = client.requests.find((url) => url.includes('/issues?'));
    expect(issuesRequest).toContain('state=open');
    expect(issuesRequest).toContain('labels=bug%2Cp1');
    expect(issuesRequest).toContain('per_page=100');
  });

  it('maps updatedSince to the API since filter (the basis of sync)', async () => {
    client.json('/labels', []).json('/milestones', []).json('/issues?', []);

    await adapterWith(client).extract({
      identifier: 'acme/api',
      updatedSince: '2026-03-01T00:00:00Z',
    });

    const issuesRequest = client.requests.find((url) => url.includes('/issues?'));
    expect(issuesRequest).toContain('since=2026-03-01T00%3A00%3A00Z');
  });

  it('omits since without updatedSince, so history is not cut short', async () => {
    client.json('/labels', []).json('/milestones', []).json('/issues?', []);

    await adapterWith(client).extract({ identifier: 'acme/api' });

    expect(client.requests.find((url) => url.includes('/issues?'))).not.toContain('since=');
  });

  it('honors maxItems as a cap on items read', async () => {
    client
      .json('/labels', [])
      .json('/milestones', [])
      .json('/issues?', [rawIssue(1), rawIssue(2), rawIssue(3)]);

    const model = await adapterWith(client).extract({ identifier: 'acme/api', maxItems: 2 });

    expect(model.issues).toHaveLength(2);
  });

  it('rejects an identifier not in owner/repo format', async () => {
    await expect(adapterWith(client).extract({ identifier: 'acme' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('classifies a rate limit with a suggested wait', async () => {
    client.on('/issues?', {
      status: 403,
      headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0' },
      body: '{"message":"You have exceeded a secondary rate limit"}',
    });

    const error = await adapterWith(client)
      .extract({ identifier: 'acme/api' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ code: 'rate-limit', retryable: true, retryAfterMs: 60_000 });
  });

  it('classifies a nonexistent repository as not-found', async () => {
    // With no route registered, the fake client returns 404.
    await expect(adapterWith(client).extract({ identifier: 'acme/missing' })).rejects.toMatchObject(
      { code: 'not-found', retryable: false },
    );
  });

  it('fails with validation when the payload does not match the schema', async () => {
    client.json('/issues?', [{ number: 'not a number' }]);

    await expect(adapterWith(client).extract({ identifier: 'acme/api' })).rejects.toMatchObject({
      code: 'validation',
      retryable: false,
    });
  });
});
