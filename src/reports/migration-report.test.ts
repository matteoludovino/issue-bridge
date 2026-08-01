import { describe, expect, it } from 'vitest';
import type { ExecutionResult } from '../core/executor/executor.js';
import type { MigrationPlan } from '../core/models/migration-plan.js';
import { buildPlan } from '../core/planner/planner.js';
import {
  makeCapabilities,
  makeComment,
  makeIssue,
  makeMappingConfig,
  makeMilestone,
  makeModel,
} from '../core/testing/fixtures.js';
import { renderExecutionReport, renderPlanReport } from './migration-report.js';

const options = { generatedAt: '2026-03-01T00:00:00Z' };

function planWith(capabilitiesOverrides = {}): MigrationPlan {
  const milestone = makeMilestone('m1', 'Sprint 1');
  return buildPlan(
    makeModel({
      milestones: [milestone],
      issues: [
        makeIssue({ id: '1', milestone: milestone.sourceRef, comments: [makeComment('c1')] }),
        makeIssue({ id: '2', type: 'bug' }),
      ],
    }),
    makeCapabilities(capabilitiesOverrides),
    makeMappingConfig(),
    'ENG',
    options,
  );
}

describe('renderPlanReport', () => {
  it('resume origem, destino e contagem de ações', () => {
    const report = renderPlanReport(planWith());

    expect(report).toContain('# Migration report — plan');
    expect(report).toContain('**Target:** project `ENG`');
    expect(report).toContain('| Epics | 1 |');
    expect(report).toContain('| Issues | 2 |');
    expect(report).toContain('| Comments | 1 |');
    expect(report).toContain('| **Total** | **4** |');
    expect(report).toContain('Plan is valid: no blocking errors');
  });

  it('destaca bloqueio e sugere a correção do finding', () => {
    const report = renderPlanReport(
      planWith({ requiredFieldsByIssueType: { Bug: ['customfield_10042'] } }),
    );

    expect(report).toContain('**Plan blocked:** 1 error(s)');
    expect(report).toContain('## Errors (these block apply)');
    expect(report).toContain('`missing_required_field`');
    expect(report).toContain('Provide a value under `mappings.fields`');
    // Aponta a issue afetada com link para a origem.
    expect(report).toContain('[#2](https://example.test/issue/2)');
  });

  it('lista observações sem tratá-las como problema', () => {
    const plan = buildPlan(
      makeModel({ issues: [makeIssue({ id: '1', checklist: [{ text: 'a', checked: false }] })] }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    const report = renderPlanReport(plan);
    expect(report).toContain('## Notes');
    expect(report).toContain('`not_migrated`');
    expect(report).not.toContain('## Errors');
  });
});

describe('renderExecutionReport', () => {
  const plan = planWith();

  function resultFor(plan: MigrationPlan): ExecutionResult {
    const [epic, issue] = plan.actions;
    if (epic === undefined || issue === undefined) throw new Error('plano vazio');
    return {
      succeeded: [
        { action: epic, targetRef: { id: '1', humanRef: 'ENG-1', url: 'https://j/browse/ENG-1' }, attempts: 3 },
        { action: issue, targetRef: { id: '2', humanRef: 'ENG-2' }, attempts: 1 },
      ],
      skipped: [],
      failed: [
        {
          action: plan.actions[3] ?? issue,
          error: { code: 'validation', message: 'field X|Y is required', retryable: false },
          attempts: 1,
        },
      ],
      startedAt: '2026-03-01T10:00:00Z',
      finishedAt: '2026-03-01T10:05:00Z',
      dryRun: false,
    };
  }

  it('resume execução, falhas e o mapa origem → destino', () => {
    const report = renderExecutionReport(plan, resultFor(plan));

    expect(report).toContain('# Migration report — execution');
    expect(report).toContain('| Completed | 2 |');
    expect(report).toContain('| Failed | 1 |');
    expect(report).toContain('## Source → target mapping');
    expect(report).toContain('[ENG-1](https://j/browse/ENG-1)');
    // Sem url, mostra a chave em código.
    expect(report).toContain('`ENG-2`');
    // Retry aparece como sinal de instabilidade.
    expect(report).toContain('1 action(s) only succeeded after a retry');
  });

  it('escapa pipe da mensagem de erro para não quebrar a tabela', () => {
    const report = renderExecutionReport(plan, resultFor(plan));
    expect(report).toContain('field X\\|Y is required');
  });

  it('deixa explícito quando foi simulação', () => {
    const simulated = { ...resultFor(plan), dryRun: true, failed: [] };
    const report = renderExecutionReport(plan, simulated);

    expect(report).toContain('# Migration report — simulation');
    expect(report).toContain('nothing was written to the target');
    expect(report).not.toContain('## Failures');
  });
});
