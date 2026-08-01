import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Testes do BINÁRIO, não das funções.
 *
 * Existem porque o wiring do commander em `main.ts` é a única parte do projeto
 * que nenhum teste de unidade alcança — e foi exatamente ali que apareceram os
 * dois bugs da fase (o `--json` do `ledger` colidindo com o global, e o ledger
 * vazio saindo em silêncio). Aqui a CLI é executada como o usuário executa:
 * processo separado, argv real, variáveis de ambiente reais, código de saída real.
 *
 * O segundo bloco vai além: migração completa contra um servidor HTTP local, o
 * que exercita config → composição → adapters → executor → ledger em disco →
 * relatório, atravessando socket de verdade.
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
        // Sem cor, para as asserções não dependerem de ANSI.
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
  GITHUB_TOKEN: 'ghp_teste',
  JIRA_EMAIL: 'bot@acme.com',
  JIRA_API_TOKEN: 'jira_teste',
};

beforeAll(async () => {
  // Compila antes de testar: um `dist` velho faria o teste validar código morto.
  await execFileAsync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
  });
}, 180_000);

describe('CLI — ajuda e erros de configuração', () => {
  let workdir: string;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'issue-bridge-proc-'));
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('--help lista os comandos e sai 0', async () => {
    const result = await runCli(['--help'], { cwd: workdir });

    expect(result.code).toBe(0);
    for (const command of ['login', 'export', 'analyze', 'apply', 'report', 'ledger']) {
      expect(result.stdout).toContain(command);
    }
  });

  it('--version imprime a versão', async () => {
    const result = await runCli(['--version'], { cwd: workdir });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('comando inexistente falha em vez de virar no-op', async () => {
    const result = await runCli(['inexistente'], { cwd: workdir });
    expect(result.code).not.toBe(0);
  });

  it('config ausente sai 2 dizendo qual arquivo faltou', async () => {
    const result = await runCli(['login', '-c', 'nao-existe.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('nao-existe.yaml');
  });

  it('credenciais ausentes saem 2 listando todas de uma vez', async () => {
    await writeFile(join(workdir, 'minima.yaml'), MINIMAL_CONFIG('https://acme.atlassian.net'), 'utf8');

    const result = await runCli(['login', '-c', 'minima.yaml'], { cwd: workdir });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('GITHUB_TOKEN');
    expect(result.stderr).toContain('JIRA_EMAIL');
    expect(result.stderr).toContain('JIRA_API_TOKEN');
  });

  it('chave desconhecida na config sai 2 apontando o typo', async () => {
    await writeFile(
      join(workdir, 'typo.yaml'),
      `${MINIMAL_CONFIG('https://acme.atlassian.net')}\nmappings:\n  milestoneStategy: epic\n`,
      'utf8',
    );

    const result = await runCli(['login', '-c', 'typo.yaml'], { cwd: workdir, env: CREDENTIALS });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('milestoneStategy');
  });

  it('ledger vazio informa no stdout em vez de sair calado', async () => {
    await writeFile(join(workdir, 'minima.yaml'), MINIMAL_CONFIG('https://acme.atlassian.net'), 'utf8');

    const result = await runCli(['ledger', '-c', 'minima.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ledger is empty');
  });

  it('ledger --json imprime JSON no stdout, não a mensagem humana', async () => {
    await writeFile(join(workdir, 'minima.yaml'), MINIMAL_CONFIG('https://acme.atlassian.net'), 'utf8');

    const result = await runCli(['ledger', '--json', '-c', 'minima.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    // Regressão: o `--json` do comando e o global são o mesmo flag no commander.
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stdout).not.toContain('empty');
  });
});

describe('CLI — migração completa contra servidor local', () => {
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
    if (address === null || typeof address === 'string') throw new Error('sem porta');
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

    // Download do anexo, com a credencial da ORIGEM.
    if (url.startsWith('/assets/')) {
      if (request.headers.authorization !== `Bearer ${CREDENTIALS.GITHUB_TOKEN}`) {
        json({ message: 'sem token da origem' }, 401);
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
      return;
    }

    // Identidade da ORIGEM (GitHub). Match exato para não colidir com
    // `/user/search`, que é do Jira.
    if (url === '/user') {
      json({ login: 'ana', id: 10 });
      return;
    }
    // ── API da origem (GitHub), usada pelo `sync`
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
          title: 'Issue que só existe no incremento',
          body: 'corpo',
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
      // Confere que o conteúdo chegou como multipart, não como URL.
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

    json({ errorMessages: [`rota não simulada: ${url}`] }, 404);
  }

  it('login valida as duas credenciais', async () => {
    const result = await runCli(['login', '-c', 'config.yaml'], {
      cwd: workdir,
      env: CREDENTIALS,
    });

    expect(result.code).toBe(0);
    expect(requests.some((entry) => entry.url.includes('/rest/api/3/myself'))).toBe(true);
  });

  it('analyze → apply → ledger → reapply, tudo pelo binário', async () => {
    const env = { ...CREDENTIALS };

    // ── analyze: só leitura do destino
    const analyze = await runCli(
      ['-v', '--json', 'analyze', '-c', 'config.yaml', '--snapshot', 'snapshot.json'],
      { cwd: workdir, env },
    );
    expect(analyze.code).toBe(0);
    // Com --json, todo evento de log é uma linha JSON válida.
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

    // ── apply sem --yes: simulação, nada escrito
    const before = requests.filter((entry) => entry.method === 'POST').length;
    const simulated = await runCli(['apply', '-c', 'config.yaml', '--plan', '.issue-bridge/plan.json'], {
      cwd: workdir,
      env,
    });
    expect(simulated.code).toBe(0);
    expect(simulated.stderr).toContain('SIMULATION');
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(before);

    // ── apply --yes: escreve de verdade
    const applied = await runCli(
      ['apply', '-c', 'config.yaml', '--plan', '.issue-bridge/plan.json', '--yes'],
      { cwd: workdir, env },
    );
    expect(applied.code).toBe(0);

    const posted = requests
      .filter((entry) => entry.method === 'POST')
      .map((entry) => entry.url.replace('/rest/api/3', ''));

    // A config usa concurrency > 1, então a ordem entre ações independentes não
    // é determinística — o conjunto e as dependências são.
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

    // A primeira escrita é sempre o épico: tudo o mais depende de algo.
    expect(posted[0]).toBe('/issue');

    // Invariante que vale com qualquer concorrência: comentário, anexo, link e
    // transição dependem de uma issue, que por sua vez depende do épico — então
    // nunca podem aparecer antes de duas criações de issue. A ordem estrita
    // entre ações independentes é coberta nos testes de unidade do Executor.
    posted.forEach((path, index) => {
      if (path === '/issue') return;
      const issuesBefore = posted.slice(0, index).filter((earlier) => earlier === '/issue').length;
      expect(issuesBefore).toBeGreaterThanOrEqual(2);
    });

    const report = await readFile(join(workdir, '.issue-bridge', 'migration-report.md'), 'utf8');
    expect(report).toContain('# Migration report — execution');
    expect(report).toContain('| Failed | 0 |');
    expect(report).toContain(`${baseUrl}/browse/ENG-2`);

    // ── ledger: persistido em disco pelo processo anterior
    const ledger = await runCli(['ledger', '--json', '-c', 'config.yaml'], { cwd: workdir, env });
    expect(ledger.code).toBe(0);
    const entries: { sourceId: string }[] = JSON.parse(ledger.stdout);
    expect(entries).toHaveLength(plan.actions.length);
    expect(entries.map((entry) => entry.sourceId)).toContain('github:acme/api:issue:1');

    // ── reexecutar não duplica nada: idempotência de ponta a ponta
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

/** Roda depois do teste acima de propósito: reaproveita o ledger já povoado. */
function syncTests(context: {
  workdir: () => string;
  requests: () => { method: string; url: string }[];
}): void {
  it('sync migra só o incremento e avança a marca d’água', async () => {
    const workdir = context.workdir();
    const env = { ...CREDENTIALS };
    const posts = (): number => context.requests().filter((entry) => entry.method === 'POST').length;
    const issueQueries = (): string[] =>
      context
        .requests()
        .filter((entry) => entry.url.startsWith('/repos/acme/api/issues'))
        .map((entry) => entry.url);

    // ── primeiro sync: sem marca d'água, cria a issue nova
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

    // ── segundo sync: usa a marca e não reescreve nada
    const afterFirst = posts();
    const second = await runCli(['sync', '-c', 'config.yaml', '--yes'], { cwd: workdir, env });

    expect(second.code).toBe(0);
    expect(issueQueries().at(-1)).toContain('since=');
    expect(posts()).toBe(afterFirst);
  }, 60_000);

  it('sync em simulação não avança a marca d’água', async () => {
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

/** Config apontando origem e destino para o servidor local. */
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
 * Snapshot escrito à mão: um épico (milestone), duas issues em hierarquia, um
 * comentário, um anexo e um link — cobre todos os tipos de ação do plano.
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
        title: 'Refatorar checkout',
        body: 'Corpo com **negrito** e `código`.',
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
            body: 'alinhado com o time',
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
        title: 'Corrigir cálculo de frete',
        body: 'ver print',
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
