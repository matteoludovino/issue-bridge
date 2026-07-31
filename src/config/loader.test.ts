import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig, resolveCredentials } from './loader.js';

const MINIMAL = `
version: 1
source:
  platform: github
  identifier: acme/api
target:
  platform: jira
  baseUrl: https://acme.atlassian.net
  projectKey: ENG
`;

describe('parseConfig', () => {
  it('aceita config mínima e aplica todos os defaults', () => {
    const config = parseConfig(MINIMAL, 'config.yaml');

    expect(config.source).toEqual({
      platform: 'github',
      identifier: 'acme/api',
      tokenEnv: 'GITHUB_TOKEN',
      includeRaw: false,
    });
    expect(config.target.epicIssueTypeName).toBe('Epic');
    expect(config.mappings.issueTypes).toEqual({
      epic: 'Epic',
      story: 'Story',
      task: 'Task',
      bug: 'Bug',
      subtask: 'Sub-task',
    });
    expect(config.mappings.statuses).toEqual({
      open: 'To Do',
      in_progress: 'In Progress',
      closed: 'Done',
    });
    expect(config.mappings.milestoneStrategy).toBe('epic');
    expect(config.mappings.fields).toEqual({ defaults: {}, byIssueType: {} });
    expect(config.extract).toEqual({ includeClosed: true, labelFilter: [] });
    expect(config.execution.ledgerPath).toBe('.issue-bridge/ledger.json');
    expect(config.execution.retry).toEqual({
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
    });
  });

  it('lê valores de custom field, incluindo por tipo de issue', () => {
    const config = parseConfig(
      `${MINIMAL}
mappings:
  milestoneStrategy: version
  defaultPriority: medium
  fields:
    defaults:
      customfield_10042:
        value: Major
    byIssueType:
      Bug:
        customfield_10050: "regressão"
`,
      'config.yaml',
    );

    expect(config.mappings.milestoneStrategy).toBe('version');
    expect(config.mappings.defaultPriority).toBe('medium');
    expect(config.mappings.fields.defaults).toEqual({ customfield_10042: { value: 'Major' } });
    expect(config.mappings.fields.byIssueType['Bug']).toEqual({
      customfield_10050: 'regressão',
    });
  });

  it('rejeita chave desconhecida em vez de ignorar silenciosamente', () => {
    const withTypo = `${MINIMAL}
mappings:
  milestoneStategy: epic
`;

    expect(() => parseConfig(withTypo, 'config.yaml')).toThrow(/milestoneStategy/);
  });

  it('reporta todos os problemas de uma vez', () => {
    const broken = `
version: 1
source:
  platform: gitlab
  identifier: sem-barra
target:
  platform: jira
  baseUrl: não-é-url
  projectKey: ENG
`;

    const error = (() => {
      try {
        parseConfig(broken, 'config.yaml');
        return null;
      } catch (caught: unknown) {
        return caught as Error;
      }
    })();

    expect(error).not.toBeNull();
    expect(error?.message).toContain('source.platform');
    expect(error?.message).toContain('source.identifier');
    expect(error?.message).toContain('target.baseUrl');
  });

  it('rejeita YAML malformado e arquivo vazio com mensagem clara', () => {
    expect(() => parseConfig('version: 1\n  source: [', 'config.yaml')).toThrow(/YAML inválido/);
    expect(() => parseConfig('', 'config.yaml')).toThrow(/está vazio/);
  });

  it('exige versão explícita do formato', () => {
    expect(() => parseConfig(MINIMAL.replace('version: 1', 'version: 2'), 'config.yaml')).toThrow(
      /version/,
    );
  });
});

describe('issue-bridge.example.yaml', () => {
  it('é válido — o exemplo não pode divergir do schema', async () => {
    const path = fileURLToPath(new URL('../../issue-bridge.example.yaml', import.meta.url));
    const config = parseConfig(await readFile(path, 'utf8'), path);

    expect(config.source.identifier).toBe('acme/api');
    expect(config.target.projectKey).toBe('ENG');
    expect(config.execution.retry.maxAttempts).toBe(5);
  });
});

describe('resolveCredentials', () => {
  const config = parseConfig(MINIMAL, 'config.yaml');

  it('resolve as três credenciais das variáveis configuradas', () => {
    expect(
      resolveCredentials(config, {
        GITHUB_TOKEN: 'ghp_x',
        JIRA_EMAIL: 'bot@acme.com',
        JIRA_API_TOKEN: 'jira_x',
      }),
    ).toEqual({
      sourceToken: 'ghp_x',
      targetEmail: 'bot@acme.com',
      targetToken: 'jira_x',
    });
  });

  it('lista TODAS as variáveis ausentes de uma vez', () => {
    const error = (() => {
      try {
        resolveCredentials(config, { JIRA_EMAIL: 'bot@acme.com' });
        return null;
      } catch (caught: unknown) {
        return caught as Error;
      }
    })();

    expect(error?.message).toContain('GITHUB_TOKEN');
    expect(error?.message).toContain('JIRA_API_TOKEN');
    expect(error?.message).not.toContain('JIRA_EMAIL (');
  });

  it('trata variável vazia como ausente', () => {
    expect(() =>
      resolveCredentials(config, {
        GITHUB_TOKEN: '   ',
        JIRA_EMAIL: 'bot@acme.com',
        JIRA_API_TOKEN: 'jira_x',
      }),
    ).toThrow(/GITHUB_TOKEN/);
  });
});
