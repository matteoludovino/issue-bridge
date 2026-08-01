import { describe, expect, it } from 'vitest';
import { toMigrationError as jiraError } from './jira/http.js';
import { nextPageUrl, redactUrl, retryDelayMs, summarizeBody } from './http.js';

describe('redactUrl', () => {
  it('remove a query string, preservando o caminho para diagnóstico', () => {
    expect(redactUrl('https://acme.atlassian.net/rest/api/3/issue/ENG-5')).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/ENG-5',
    );
    expect(redactUrl('https://api.github.com/repos/acme/api/issues?since=2026-01-01&page=2')).toBe(
      'https://api.github.com/repos/acme/api/issues?[redigido]',
    );
  });

  it('não deixa JQL vazar: a busca do Jira leva título de issue na query', () => {
    const url =
      'https://acme.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20%22ENG%22%20AND%20summary%20~%20%22falha%20no%20login%20do%20cliente%22';

    expect(redactUrl(url)).not.toContain('falha');
    expect(redactUrl(url)).toContain('/rest/api/3/search/jql');
  });

  it('mensagem de erro do Jira já sai redigida', () => {
    const error = jiraError(
      { status: 500, headers: {}, body: '{"errorMessages":["boom"]}' },
      'https://acme.atlassian.net/rest/api/3/search/jql?jql=summary ~ "segredo do cliente"',
    );

    expect(error.message).not.toContain('segredo');
    expect(error.message).toContain('[redigido]');
  });

  it('URL malformada ainda perde a query', () => {
    expect(redactUrl('não-é-url?token=abc')).toBe('não-é-url');
  });
});

describe('nextPageUrl', () => {
  it('extrai rel="next" entre vários links', () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextPageUrl(header)).toBe('https://api.github.com/x?page=2');
  });

  it('devolve undefined na última página e sem header', () => {
    expect(nextPageUrl('<https://api.github.com/x?page=9>; rel="last"')).toBeUndefined();
    expect(nextPageUrl(undefined)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('prefere retry-after, em segundos', () => {
    expect(retryDelayMs({ 'retry-after': '60' })).toBe(60_000);
  });

  it('ignora a janela de reset quando ainda há cota', () => {
    expect(retryDelayMs({ 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '999' })).toBeUndefined();
  });

  it('sem headers não sugere espera', () => {
    expect(retryDelayMs({})).toBeUndefined();
  });
});

describe('summarizeBody', () => {
  it('trunca corpo longo e devolve vazio para corpo em branco', () => {
    expect(summarizeBody('a'.repeat(500), 10)).toBe(`${'a'.repeat(10)}…`);
    expect(summarizeBody('   ')).toBe('');
  });
});
