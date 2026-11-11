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
  it('accepts a minimal config and applies all defaults', () => {
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

  it('reads custom field values, including per issue type', () => {
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
        customfield_10050: "regression"
`,
      'config.yaml',
    );

    expect(config.mappings.milestoneStrategy).toBe('version');
    expect(config.mappings.defaultPriority).toBe('medium');
    expect(config.mappings.fields.defaults).toEqual({ customfield_10042: { value: 'Major' } });
    expect(config.mappings.fields.byIssueType['Bug']).toEqual({
      customfield_10050: 'regression',
    });
  });

  it('rejects an unknown key instead of silently ignoring it', () => {
    const withTypo = `${MINIMAL}
mappings:
  milestoneStategy: epic
`;

    expect(() => parseConfig(withTypo, 'config.yaml')).toThrow(/milestoneStategy/);
  });

  it('reports all problems at once', () => {
    const broken = `
version: 1
source:
  platform: gitlab
  identifier: no-slash
target:
  platform: jira
  baseUrl: not-a-url
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

  it('rejects malformed YAML and an empty file with a clear message', () => {
    expect(() => parseConfig('version: 1\n  source: [', 'config.yaml')).toThrow(/Invalid YAML/);
    expect(() => parseConfig('', 'config.yaml')).toThrow(/is empty/);
  });

  it('requires an explicit format version', () => {
    expect(() => parseConfig(MINIMAL.replace('version: 1', 'version: 2'), 'config.yaml')).toThrow(
      /version/,
    );
  });
});

describe('issue-bridge.example.yaml', () => {
  it('is valid — the example must not diverge from the schema', async () => {
    const path = fileURLToPath(new URL('../../issue-bridge.example.yaml', import.meta.url));
    const config = parseConfig(await readFile(path, 'utf8'), path);

    expect(config.source.identifier).toBe('acme/api');
    expect(config.target.projectKey).toBe('ENG');
    expect(config.execution.retry.maxAttempts).toBe(5);
  });
});

describe('resolveCredentials', () => {
  const config = parseConfig(MINIMAL, 'config.yaml');

  it('resolves the three credentials from the configured variables', () => {
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

  it('lists ALL missing variables at once', () => {
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

  it('treats an empty variable as missing', () => {
    expect(() =>
      resolveCredentials(config, {
        GITHUB_TOKEN: '   ',
        JIRA_EMAIL: 'bot@acme.com',
        JIRA_API_TOKEN: 'jira_x',
      }),
    ).toThrow(/GITHUB_TOKEN/);
  });
});
