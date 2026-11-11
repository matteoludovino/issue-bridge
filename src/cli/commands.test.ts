import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config/loader.js';
import { InMemoryRollbackStore } from '../core/executor/in-memory-rollback-store.js';
import { SyncStateStore } from '../storage/sync-state.js';
import {
  FakeAttachmentFetcher,
  FakeSourceAdapter,
  FakeTargetAdapter,
  RecordingLogger,
  RecordingSleeper,
  makeComment,
  makeIssue,
  makeMilestone,
  makeModel,
} from '../core/testing/fixtures.js';
import {
  EXIT,
  runAnalyze,
  runApply,
  runExport,
  runLedger,
  runLogin,
  runReport,
  runSync,
} from './commands.js';
import type { CommandDeps } from './commands.js';

const CONFIG_YAML = `
version: 1
source:
  platform: github
  identifier: acme/api
target:
  platform: jira
  baseUrl: https://acme.atlassian.net
  projectKey: ENG
`;

const milestone = makeMilestone('m1', 'Sprint 1');
const model = makeModel({
  milestones: [milestone],
  issues: [
    makeIssue({ id: '1', milestone: milestone.sourceRef, comments: [makeComment('c1')] }),
    makeIssue({ id: '2', type: 'bug', status: 'closed' }),
  ],
});

describe('CLI commands', () => {
  let outDir: string;
  let source: FakeSourceAdapter;
  let target: FakeTargetAdapter;
  let logger: RecordingLogger;
  let stdout: string[];
  let deps: CommandDeps;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'issue-bridge-cli-'));
    source = new FakeSourceAdapter(model);
    target = new FakeTargetAdapter();
    logger = new RecordingLogger();
    stdout = [];
    deps = {
      config: parseConfig(CONFIG_YAML, 'config.yaml'),
      source,
      target,
      store: new InMemoryRollbackStore(),
      logger,
      clock: { now: () => '2026-03-01T00:00:00Z' },
      attachments: new FakeAttachmentFetcher(),
      syncState: new SyncStateStore(join(outDir, 'sync-state.json')),
      sleeper: new RecordingSleeper(),
      write: (text) => stdout.push(text),
    };
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('login validates both credentials', async () => {
    expect(await runLogin(deps)).toBe(EXIT.ok);
    expect(source.authenticated).toBe(true);
    expect(target.calls).toContain('authenticate:');
  });

  it('export writes the snapshot without touching the target', async () => {
    expect(await runExport(deps, { outDir })).toBe(EXIT.ok);

    const snapshot: unknown = JSON.parse(await readFile(join(outDir, 'snapshot.json'), 'utf8'));
    expect(snapshot).toMatchObject({ issues: [{ title: 'Issue 1' }, { title: 'Issue 2' }] });
    expect(target.calls).toEqual([]);
    // Extraction options come from the config.
    expect(source.extractCalls[0]).toEqual({ identifier: 'acme/api', includeClosed: true });
  });

  it('analyze writes the plan and report and exits 0 when the plan is valid', async () => {
    expect(await runAnalyze(deps, { outDir })).toBe(EXIT.ok);

    const plan: unknown = JSON.parse(await readFile(join(outDir, 'plan.json'), 'utf8'));
    expect(plan).toMatchObject({ schemaVersion: 1, targetProjectKey: 'ENG' });

    const report = await readFile(join(outDir, 'migration-report.md'), 'utf8');
    expect(report).toContain('Plan is valid');
    // Nothing was written to the target, only capability discovery.
    expect(target.calls).toEqual(['discoverCapabilities:ENG']);
  });

  it('analyze exits 1 on a blocking error, so it works as a CI gate', async () => {
    const strictTarget = new FakeTargetAdapter();
    strictTarget.discoverCapabilities = () =>
      Promise.resolve({
        issueTypes: ['Task'],
        priorities: [],
        workflow: { statuses: ['To Do'], transitions: {} },
        components: [],
        versions: [],
        labels: [],
        requiredFieldsByIssueType: {},
        customFields: [],
      });

    const code = await runAnalyze({ ...deps, target: strictTarget }, { outDir });

    expect(code).toBe(EXIT.problems);
    const report = await readFile(join(outDir, 'migration-report.md'), 'utf8');
    expect(report).toContain('**Plan blocked:**');
    expect(report).toContain('`unmapped_value`');
    expect(logger.errors.join(' ')).toContain('block apply');
  });

  it('analyze reuses the snapshot on disk without calling the source', async () => {
    await runExport(deps, { outDir });
    const fresh = new FakeSourceAdapter(model);

    await runAnalyze(
      { ...deps, source: fresh },
      { outDir, snapshot: join(outDir, 'snapshot.json') },
    );

    expect(fresh.extractCalls).toEqual([]);
  });

  it('apply without --yes runs as a dry run and warns', async () => {
    const code = await runApply(deps, { outDir });

    expect(code).toBe(EXIT.ok);
    expect(logger.warns.join(' ')).toContain('SIMULATION');
    // No writes beyond capability discovery.
    expect(target.calls).toEqual(['discoverCapabilities:ENG']);

    const execution: unknown = JSON.parse(await readFile(join(outDir, 'execution.json'), 'utf8'));
    expect(execution).toMatchObject({ dryRun: true });
    expect(await readFile(join(outDir, 'migration-report.md'), 'utf8')).toContain('simulation');
  });

  it('apply with --yes writes to the target and saves the execution report', async () => {
    const code = await runApply(deps, { outDir, yes: true });

    expect(code).toBe(EXIT.ok);
    expect(target.calls.filter((call) => call.startsWith('createIssue'))).toHaveLength(2);
    expect(target.calls.some((call) => call.startsWith('createEpic'))).toBe(true);

    const report = await readFile(join(outDir, 'migration-report.md'), 'utf8');
    expect(report).toContain('# Migration report — execution');
    expect(report).toContain('## Source → target mapping');
  });

  it('apply exits 1 when any action fails, and the report shows why', async () => {
    target.failingSourceIds.add('fake:acme/api:issue:2');

    const code = await runApply(deps, { outDir, yes: true });

    expect(code).toBe(EXIT.problems);
    const report = await readFile(join(outDir, 'migration-report.md'), 'utf8');
    expect(report).toContain('## Failures');
    expect(report).toContain('`validation`');
    expect(logger.errors.join(' ')).toContain('Re-running is safe');
  });

  it('apply reuses an existing plan without re-extracting', async () => {
    await runAnalyze(deps, { outDir });
    const fresh = new FakeSourceAdapter(model);

    const code = await runApply(
      { ...deps, source: fresh },
      { outDir, plan: join(outDir, 'plan.json'), yes: true },
    );

    expect(code).toBe(EXIT.ok);
    expect(fresh.extractCalls).toEqual([]);
  });

  it('report regenerates from the plan before apply and from the execution after', async () => {
    await runAnalyze(deps, { outDir });

    const planOnly = join(outDir, 'plan-report.md');
    expect(await runReport(deps, { outDir, out: planOnly })).toBe(EXIT.ok);
    expect(await readFile(planOnly, 'utf8')).toContain('— plan');

    await runApply(deps, { outDir, yes: true });
    const afterApply = join(outDir, 'exec-report.md');
    await runReport(deps, { outDir, out: afterApply });
    expect(await readFile(afterApply, 'utf8')).toContain('— execution');
  });

  describe('incremental sync', () => {
    it('first run reads everything and advances the watermark', async () => {
      const code = await runSync(deps, { outDir, yes: true });

      expect(code).toBe(EXIT.ok);
      // No previous watermark: extraction without a date filter.
      expect(source.extractCalls[0]?.updatedSince).toBeUndefined();
      expect(await deps.syncState?.read('acme/api')).toEqual({
        version: 1,
        identifier: 'acme/api',
        lastSyncedAt: '2026-03-01T00:00:00Z',
      });
    });

    it('second run filters by the watermark and rewrites nothing', async () => {
      await runSync(deps, { outDir, yes: true });
      const postsAfterFirst = target.calls.length;

      const second = new FakeSourceAdapter(model);
      const code = await runSync({ ...deps, source: second }, { outDir, yes: true });

      expect(code).toBe(EXIT.ok);
      expect(second.extractCalls[0]?.updatedSince).toBe('2026-03-01T00:00:00Z');
      // Idempotency: even when re-reading the same items, nothing new is created.
      expect(target.calls.length).toBe(postsAfterFirst + 1); // only discoverCapabilities
      expect(target.calls.at(-1)).toBe('discoverCapabilities:ENG');
    });

    it('--full ignores the watermark and re-reads the whole source', async () => {
      await runSync(deps, { outDir, yes: true });

      const second = new FakeSourceAdapter(model);
      await runSync({ ...deps, source: second }, { outDir, yes: true, full: true });

      expect(second.extractCalls[0]?.updatedSince).toBeUndefined();
    });

    it('--since overrides the stored watermark', async () => {
      await runSync(deps, { outDir, yes: true });

      const second = new FakeSourceAdapter(model);
      await runSync(
        { ...deps, source: second },
        { outDir, yes: true, since: '2025-01-01T00:00:00Z' },
      );

      expect(second.extractCalls[0]?.updatedSince).toBe('2025-01-01T00:00:00Z');
    });

    it('a dry run does NOT advance the watermark', async () => {
      const code = await runSync(deps, { outDir });

      expect(code).toBe(EXIT.ok);
      expect(logger.warns.join(' ')).toContain('SIMULATION');
      // Advancing here would hide items that never reached the target.
      expect(await deps.syncState?.read('acme/api')).toBeNull();
    });

    it('a failure does NOT advance the watermark', async () => {
      target.failingSourceIds.add('fake:acme/api:issue:1');

      const code = await runSync(deps, { outDir, yes: true });

      expect(code).toBe(EXIT.problems);
      expect(await deps.syncState?.read('acme/api')).toBeNull();
    });

    it('a source with nothing new advances the watermark without writing anything', async () => {
      const vazia = new FakeSourceAdapter(makeModel({ issues: [] }));

      const code = await runSync({ ...deps, source: vazia }, { outDir, yes: true });

      expect(code).toBe(EXIT.ok);
      expect(logger.infos.join(' ')).toContain('Nothing new');
      expect(target.calls.filter((call) => call.startsWith('createIssue'))).toEqual([]);
      expect(await deps.syncState?.read('acme/api')).not.toBeNull();
    });
  });

  it('ledger lists the mappings and supports JSON on stdout', async () => {
    await runApply(deps, { outDir, yes: true });

    expect(await runLedger(deps, {})).toBe(EXIT.ok);
    expect(stdout.join('')).toContain('fake:acme/api:issue:1');

    stdout.length = 0;
    await runLedger(deps, { json: true });
    const parsed: unknown = JSON.parse(stdout.join(''));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('an empty ledger says it is empty instead of exiting silently', async () => {
    expect(await runLedger(deps, {})).toBe(EXIT.ok);
    expect(stdout.join('')).toContain('ledger is empty');
  });
});
