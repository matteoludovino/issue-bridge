import { describe, expect, it } from 'vitest';
import { toMigrationError as jiraError } from './jira/http.js';
import { nextPageUrl, redactUrl, retryDelayMs, summarizeBody } from './http.js';

describe('redactUrl', () => {
  it('strips the query string, keeping the path for diagnosis', () => {
    expect(redactUrl('https://acme.atlassian.net/rest/api/3/issue/ENG-5')).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/ENG-5',
    );
    expect(redactUrl('https://api.github.com/repos/acme/api/issues?since=2026-01-01&page=2')).toBe(
      'https://api.github.com/repos/acme/api/issues?[redacted]',
    );
  });

  it('does not leak JQL: Jira search carries the issue title in the query', () => {
    const url =
      'https://acme.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20%22ENG%22%20AND%20summary%20~%20%22customer%20login%20failure%22';

    expect(redactUrl(url)).not.toContain('failure');
    expect(redactUrl(url)).toContain('/rest/api/3/search/jql');
  });

  it('Jira error messages come out already redacted', () => {
    const error = jiraError(
      { status: 500, headers: {}, body: '{"errorMessages":["boom"]}' },
      'https://acme.atlassian.net/rest/api/3/search/jql?jql=summary ~ "customer secret"',
    );

    expect(error.message).not.toContain('secret');
    expect(error.message).toContain('[redacted]');
  });

  it('a malformed URL still loses its query', () => {
    expect(redactUrl('not-a-url?token=abc')).toBe('not-a-url');
  });
});

describe('nextPageUrl', () => {
  it('extracts rel="next" from several links', () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextPageUrl(header)).toBe('https://api.github.com/x?page=2');
  });

  it('returns undefined on the last page and without a header', () => {
    expect(nextPageUrl('<https://api.github.com/x?page=9>; rel="last"')).toBeUndefined();
    expect(nextPageUrl(undefined)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('prefers retry-after, in seconds', () => {
    expect(retryDelayMs({ 'retry-after': '60' })).toBe(60_000);
  });

  it('ignores the reset window while quota remains', () => {
    expect(retryDelayMs({ 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '999' })).toBeUndefined();
  });

  it('suggests no wait without headers', () => {
    expect(retryDelayMs({})).toBeUndefined();
  });
});

describe('summarizeBody', () => {
  it('truncates a long body and returns empty for a blank one', () => {
    expect(summarizeBody('a'.repeat(500), 10)).toBe(`${'a'.repeat(10)}…`);
    expect(summarizeBody('   ')).toBe('');
  });
});
