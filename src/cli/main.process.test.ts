import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tests of the BINARY, not of the functions.
 *
 * They exist because the commander wiring in `main.ts` is the only part of the project
 * that no unit test reaches — and that is exactly where this phase's two bugs
 * showed up (`ledger`'s `--json` clashing with the global one, and the empty
 * ledger exiting silently). Here the CLI runs the way a user runs it:
 * a separate process, real argv, real environment variables, real exit code.
 *
 * The second block goes further: a full migration against a local HTTP server,
 * which exercises config → composition → adapters → executor → on-disk ledger →
 * report, over a real socket.
 */

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binary = join(repoRoot, 'dist', 'cli', 'main.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: options.cwd,
      env: {
        PATH: process.env['PATH'] ?? '',
        // No color, so the assertions do not depend on ANSI.
        NO_COLOR: '1',
        ...options.env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const CREDENTIALS = {
  GITHUB_TOKEN: 'ghp_test',
  JIRA_EMAIL: 'bot@acme.com',
  JIRA_API_TOKEN: 'jira_test',
};

beforeAll(async () => {
  // Build before testing: a stale `dist` would make the test validate dead code.
  await execFileAsync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
  });
}, 180_000);

describe('CLI — help and configuration errors', () => {
  let workdir: string;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'issue-bridge-proc-'));
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('--help lists the commands and exits 0', async () => {
    const result = await runCli(['--help'], { cwd: workdir });

    expect(result.code).toBe(0);
    for (const command of ['login', 'export', 'analyze', 'apply', 'report', 'ledger']) {
      expect(result.stdout).toContain(command);
    }
  });

  it('--version prints the version', async () => {
    const result = await runCli(['--version'], { cwd: workdir });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('an unknown command fails instead of becoming a no-op', async () => {
    const result = await runCli(['nonexistent'], { cwd: workdir });
    expect(result.code).not.toBe(0);
  });

  it('a missing config exits 2 naming the missing file', async () => {
    const result = await runCli(['login', '-c', 'does-not-exist.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('does-not-exist.yaml');
  });

  it('missing credentials exit 2, listing all of them at once', async () => {
    await writeFile(join(workdir, 'minimal.yaml'), MINIMAL_CONFIG('https://acme.atlassian.net'), 'utf8');

    const result = await runCli(['login', '-c', 'minimal.yaml'], { cwd: workdir });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('GITHUB_TOKEN');
    expect(result.stderr).toContain('JIRA_EMAIL');
    expect(result.stderr).toContain('JIRA_API_TOKEN');
  });

  it('an unknown config key exits 2, pointing at the typo', async () => {
    await writeFile(
      join(workdir, 'typo.yaml'),
      `${MINIMAL_CONFIG('https://acme.atlassian.net')}\nmappings:\n  milestoneStategy: epic\n`,
      'utf8',
    );

    const result = await runCli(['login', '-c', 'typo.yaml'], { cwd: workdir, env: CREDENTIALS });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('milestoneStategy');
  });

  it('an empty ledger says so on stdout instead of exiting silently', async () => {
    await writeFile(join(workdir, 'minimal.yaml'), MINIMAL_CONFIG('https://acme.atlassian.net'), 'utf8');

    const result = await runCli(['ledger', '-c', 'minimal.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ledger is empty');
  });

  it('ledger --json prints JSON on stdout, not the human message', async () => {
    await writeFile(join(workdir, 'minimal.yaml'), MINIMAL_CONFIG('https://acme.atlassian.net'), 'utf8');

    const result = await runCli(['ledger', '--json', '-c', 'minimal.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    // Regression: the command's `--json` and the global one are the same flag in commander.
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stdout).not.toContain('empty');
  });
});

describe('CLI — full migration against a local server', () => {
  let workdir: string;
  let server: Server;
  let baseUrl: string;
  const requests: { method: string; url: string; body: string }[] = [];
  let issueCounter = 0;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'issue-bridge-e2e-'));

    server = createServer((request, response) => {
      collectBody(request)
        .then((body) => {
          requests.push({ method: request.method ?? '', url: request.url ?? '', body });
          handle(request, response, body);
        })
        .catch(() => {
          response.writeHead(500).end();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;

    await writeFile(join(workdir, 'config.yaml'), configFor(baseUrl), 'utf8');
    await writeFile(join(workdir, 'snapshot.json'), JSON.stringify(snapshotFor(baseUrl)), 'utf8');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workdir, { recursive: true, force: true });
  });

  function handle(request: IncomingMessage, response: ServerResponse, body: string): void {
    const url = request.url ?? '';
    const json = (payload: unknown, status = 200): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    // Attachment download, with the SOURCE credential.
    if (url.startsWith('/assets/')) {
      if (request.headers.authorization !== `Bearer ${CREDENTIALS.GITHUB_TOKEN}`) {
        json({ message: 'missing source token' }, 401);
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
      return;
    }

    // SOURCE identity (GitHub). Exact match so it does not collide with
    // `/user/search`, which belongs to Jira.
    if (url === '/user') {
      json({ login: 'ana', id: 10 });
      return;
    }
    // ── Source API (GitHub), used by `sync`
    if (url.startsWith('/repos/acme/api/labels')) {
      json([]);
      return;
    }
    if (url.startsWith('/repos/acme/api/milestones')) {
      json([]);
      return;
    }
    if (url.startsWith('/repos/acme/api/issues')) {
      json([
        {
          number: 5,
          title: 'Issue that only exists in the increment',
          body: 'body',
          state: 'open',
          labels: [],
          user: { login: 'ana', id: 10, html_url: `${baseUrl}/ana` },
          assignees: [],
          created_at: '2026-03-02T00:00:00Z',
          updated_at: '2026-03-02T00:00:00Z',
          html_url: `${baseUrl}/acme/api/issues/5`,
          comments: 0,
        },
      ]);
      return;
    }

    if (url.includes('/rest/api/3/myself')) {
      json({ accountId: 'acc-bot', displayName: 'Bot' });
      return;
    }
    if (url.includes('/rest/api/3/project/ENG/statuses')) {
      json([
        {
          id: '1',
          name: 'Task',
          statuses: [
            { id: '1', name: 'To Do' },
            { id: '2', name: 'Done' },
          ],
        },
      ]);
      return;
    }
    if (url.includes('/issuetypes/')) {
      json({
        fields: [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }],
      });
      return;
    }
    if (url.includes('/issuetypes?')) {
      json({
        issueTypes: [
          { id: '10001', name: 'Task', subtask: false },
          { id: '10002', name: 'Epic', subtask: false },
        ],
      });
      return;
    }
    if (url.includes('/rest/api/3/priority')) {
      json([{ id: '1', name: 'Medium' }]);
      return;
    }
    if (url.includes('/rest/api/3/label')) {
      json({ values: [] });
      return;
    }
    if (url.includes('/rest/api/3/project/ENG')) {
      json({ id: '10000', key: 'ENG', name: 'Engenharia', components: [], versions: [] });
      return;
    }
    if (url.includes('/user/search')) {
      json([]);
      return;
    }
    if (url.includes('/transitions')) {
      if (request.method === 'GET') {
        json({ transitions: [{ id: '31', name: 'Concluir', to: { id: '2', name: 'Done' } }] });
        return;
      }
      response.writeHead(204).end();
      return;
    }
    if (url.includes('/attachments')) {
      // Checks that the content arrived as multipart, not as a URL.
      expect(body).toContain('filename="print.png"');
      json([{ id: '900', filename: 'print.png' }]);
      return;
    }
    if (url.includes('/comment')) {
      json({ id: '800' });
      return;
    }
    if (url.includes('/issueLink')) {
      response.writeHead(201).end();
      return;
    }
    if (url.includes('/rest/api/3/issue')) {
      issueCounter += 1;
      json({ id: String(20_000 + issueCounter), key: `ENG-${String(issueCounter)}` });
      return;
    }

    json({ errorMessages: [`route not mocked: ${url}`] }, 404);
  }

  it('login validates both credentials', async () => {
    const result = await runCli(['login', '-c', 'config.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(0);
    expect(requests.some((entry) => entry.url.includes('/rest/api/3/myself'))).toBe(true);
  });

  it('analyze → apply → ledger → reapply, all through the binary', async () => {
    const env = { ...CREDENTIALS };

    // ── analyze: read-only against the target
    const analyze = await runCli(
      ['-v', '--json', 'analyze', '-c', 'config.yaml', '--snapshot', 'snapshot.json'],
      { cwd: workdir, env },
    );
    expect(analyze.code).toBe(0);
    // With --json, every log event is a valid JSON line.
    for (const line of analyze.stderr.trim().split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    const plan: { actions: { kind: string }[] } = JSON.parse(
      await readFile(join(workdir, '.issue-bridge', 'plan.json'), 'utf8'),
    );
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'create_epic',
      'create_issue',
      'create_issue',
      'create_comment',
      'create_attachment',
      'create_link',
      'transition_issue',
    ]);
    expect(await readFile(join(workdir, '.issue-bridge', 'migration-report.md'), 'utf8')).toContain(
      'Plan is valid',
    );

    // ── apply without --yes: dry run, nothing written
    const before = requests.filter((entry) => entry.method === 'POST').length;
    const simulated = await runCli(['apply', '-c', 'config.yaml', '--plan', '.issue-bridge/plan.json'], {
      cwd: workdir,
      env,
    });
    expect(simulated.code).toBe(0);
    expect(simulated.stderr).toContain('SIMULATION');
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(before);

    // ── apply --yes: writes for real
    const applied = await runCli(
      ['apply', '-c', 'config.yaml', '--plan', '.issue-bridge/plan.json', '--yes'],
      { cwd: workdir, env },
    );
    expect(applied.code).toBe(0);

    const posted = requests
      .filter((entry) => entry.method === 'POST')
      .map((entry) => entry.url.replace('/rest/api/3', ''));

    // The config uses concurrency > 1, so the order of independent actions is not
    // deterministic — the set and the dependencies are.
    expect([...posted].sort()).toEqual(
      [
        '/issue',
        '/issue',
        '/issue',
        '/issue/20002/comment',
        '/issue/20003/attachments',
        '/issueLink',
        '/issue/20003/transitions',
      ].sort(),
    );

    // The first write is always the epic: everything else depends on something.
    expect(posted[0]).toBe('/issue');

    // Invariant that holds at any concurrency: comment, attachment, link and
    // transition depend on an issue, which in turn depends on the epic — so
    // they can never appear before two issue creations. Strict ordering
    // between independent actions is covered by the Executor unit tests.
    posted.forEach((path, index) => {
      if (path === '/issue') return;
      const issuesBefore = posted.slice(0, index).filter((earlier) => earlier === '/issue').length;
      expect(issuesBefore).toBeGreaterThanOrEqual(2);
    });

    const report = await readFile(join(workdir, '.issue-bridge', 'migration-report.md'), 'utf8');
    expect(report).toContain('# Migration report — execution');
    expect(report).toContain('| Failed | 0 |');
    expect(report).toContain(`${baseUrl}/browse/ENG-2`);

    // ── ledger: persisted to disk by the previous process
    const ledger = await runCli(['ledger', '--json', '-c', 'config.yaml'], { cwd: workdir, env });
    expect(ledger.code).toBe(0);
    const entries: { sourceId: string }[] = JSON.parse(ledger.stdout);
    expect(entries).toHaveLength(plan.actions.length);
    expect(entries.map((entry) => entry.sourceId)).toContain('github:acme/api:issue:1');

    // ── re-running duplicates nothing: end-to-end idempotency
    const postsAfterApply = requests.filter((entry) => entry.method === 'POST').length;
    const reapplied = await runCli(
      ['apply', '-c', 'config.yaml', '--plan', '.issue-bridge/plan.json', '--yes'],
      { cwd: workdir, env },
    );
    expect(reapplied.code).toBe(0);
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(postsAfterApply);

    const execution: { skipped: unknown[]; succeeded: unknown[] } = JSON.parse(
      await readFile(join(workdir, '.issue-bridge', 'execution.json'), 'utf8'),
    );
    expect(execution.skipped).toHaveLength(plan.actions.length);
    expect(execution.succeeded).toHaveLength(0);
  }, 60_000);

  syncTests({ workdir: () => workdir, requests: () => requests });
});

/** Runs after the test above on purpose: it reuses the already-populated ledger. */
function syncTests(context: {
  workdir: () => string;
  requests: () => { method: string; url: string }[];
}): void {
  it('sync migrates only the increment and advances the watermark', async () => {
    const workdir = context.workdir();
    const env = { ...CREDENTIALS };
    const posts = (): number => context.requests().filter((entry) => entry.method === 'POST').length;
    const issueQueries = (): string[] =>
      context
        .requests()
        .filter((entry) => entry.url.startsWith('/repos/acme/api/issues'))
        .map((entry) => entry.url);

    // ── first sync: no watermark, creates the new issue
    const before = posts();
    const first = await runCli(['sync', '-c', 'config.yaml', '--yes'], { cwd: workdir, env });

    expect(first.code).toBe(0);
    expect(posts() - before).toBe(1);
    expect(issueQueries()[0]).not.toContain('since=');

    const state: { identifier: string; lastSyncedAt: string } = JSON.parse(
      await readFile(join(workdir, '.issue-bridge', 'sync-state.json'), 'utf8'),
    );
    expect(state.identifier).toBe('acme/api');
    expect(Date.parse(state.lastSyncedAt)).not.toBeNaN();

    // ── second sync: uses the watermark and rewrites nothing
    const afterFirst = posts();
    const second = await runCli(['sync', '-c', 'config.yaml', '--yes'], { cwd: workdir, env });

    expect(second.code).toBe(0);
    expect(issueQueries().at(-1)).toContain('since=');
    expect(posts()).toBe(afterFirst);
  }, 60_000);

  it('a dry-run sync does not advance the watermark', async () => {
    const workdir = context.workdir();
    const statePath = join(workdir, '.issue-bridge', 'sync-state.json');
    const before = await readFile(statePath, 'utf8');

    const result = await runCli(['sync', '-c', 'config.yaml', '--full'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('SIMULATION');
    expect(await readFile(statePath, 'utf8')).toBe(before);
  }, 60_000);
}

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const MINIMAL_CONFIG = (jiraBaseUrl: string): string => `version: 1
source:
  platform: github
  identifier: acme/api
target:
  platform: jira
  baseUrl: ${jiraBaseUrl}
  projectKey: ENG
`;

/** Config pointing both source and target at the local server. */
const configFor = (baseUrl: string): string => `version: 1
source:
  platform: github
  identifier: acme/api
  baseUrl: ${baseUrl}
target:
  platform: jira
  baseUrl: ${baseUrl}
  projectKey: ENG
mappings:
  issueTypes:
    epic: Epic
    story: Task
    task: Task
    bug: Task
    subtask: Task
  statuses:
    open: To Do
    in_progress: To Do
    closed: Done
  milestoneStrategy: epic
execution:
  ledgerPath: .issue-bridge/ledger.json
  retry:
    maxAttempts: 2
    baseDelayMs: 10
    maxDelayMs: 20
`;

/**
 * Hand-written snapshot: one epic (milestone), two issues in a hierarchy, one
 * comment, one attachment and one link — covers every plan action type.
 */
function snapshotFor(baseUrl: string): unknown {
  const ref = (kind: string, id: string) => ({
    platform: 'github',
    id: `github:acme/api:${kind}:${id}`,
    humanRef: `#${id}`,
    url: `${baseUrl}/acme/api/${kind}/${id}`,
  });
  const author = { displayName: 'Ana Souza' };

  return {
    source: { platform: 'github', identifier: 'acme/api', extractedAt: '2026-03-01T00:00:00Z' },
    labels: [],
    milestones: [
      {
        sourceRef: ref('milestone', 'm1'),
        title: 'Sprint 1',
        state: 'open',
      },
    ],
    issues: [
      {
        sourceRef: ref('issue', '1'),
        title: 'Refactor checkout',
        body: 'Body with **bold** and `code`.',
        type: 'task',
        status: 'open',
        labels: [],
        assignees: [],
        author,
        createdAt: '2026-01-01T00:00:00Z',
        milestone: ref('milestone', 'm1'),
        comments: [
          {
            sourceRef: ref('comment', 'c1'),
            author,
            body: 'aligned with the team',
            createdAt: '2026-01-02T00:00:00Z',
            attachments: [],
          },
        ],
        attachments: [],
        links: [{ type: 'relates_to', targetSourceRef: ref('issue', '2') }],
        checklist: [],
      },
      {
        sourceRef: ref('issue', '2'),
        title: 'Fix shipping cost calculation',
        body: 'see screenshot',
        type: 'bug',
        status: 'closed',
        closedAt: '2026-02-01T00:00:00Z',
        labels: [],
        assignees: [],
        author,
        createdAt: '2026-01-03T00:00:00Z',
        parentSourceRef: ref('issue', '1'),
        comments: [],
        attachments: [
          {
            sourceRef: ref('attachment', 'a1'),
            filename: 'print.png',
            url: `${baseUrl}/assets/print.png`,
            origin: 'inline_body',
          },
        ],
        links: [],
        checklist: [],
      },
    ],
  };
}
