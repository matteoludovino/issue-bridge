import { describe, expect, it } from 'vitest';
import type { CreateIssueAction, PlanAction } from '../models/migration-plan.js';
import { hasBlockingErrors } from '../models/migration-plan.js';
import {
  makeCapabilities,
  makeComment,
  makeIssue,
  makeMappingConfig,
  makeMilestone,
  makeModel,
  ref,
} from '../testing/fixtures.js';
import { buildPlan } from './planner.js';

const GENERATED_AT = '2026-02-01T12:00:00Z';
const options = { generatedAt: GENERATED_AT };

const kinds = (actions: PlanAction[]): string[] => actions.map((action) => action.kind);

const issueActions = (actions: PlanAction[]): CreateIssueAction[] =>
  actions.filter((action): action is CreateIssueAction => action.kind === 'create_issue');

const codes = (plan: { findings: { code: string; severity: string }[] }, severity: string) =>
  plan.findings.filter((finding) => finding.severity === severity).map((finding) => finding.code);

describe('buildPlan — 1. milestones', () => {
  it('cria épico e liga a issue via epicActionId quando a estratégia é "epic"', () => {
    const milestone = makeMilestone('m1', 'Sprint 1');
    const model = makeModel({
      milestones: [milestone],
      issues: [makeIssue({ id: '1', milestone: milestone.sourceRef })],
    });

    const plan = buildPlan(
      model,
      makeCapabilities(),
      makeMappingConfig({ milestoneStrategy: 'epic' }),
      'ENG',
      options,
    );

    expect(kinds(plan.actions)).toEqual(['create_epic', 'create_issue']);
    const [epic] = plan.actions;
    const [issue] = issueActions(plan.actions);
    expect(epic).toMatchObject({ kind: 'create_epic', name: 'Sprint 1' });
    expect(issue?.epicActionId).toBe(epic?.id);
    expect(issue?.versionActionId).toBeUndefined();
    expect(issue?.dependsOn).toEqual([epic?.id]);
  });

  it('cria versão com releaseDate quando a estratégia é "version"', () => {
    const milestone = makeMilestone('m1', 'v1.2.0', '2026-03-31');
    const model = makeModel({
      milestones: [milestone],
      issues: [makeIssue({ id: '1', milestone: milestone.sourceRef })],
    });

    const plan = buildPlan(
      model,
      makeCapabilities(),
      makeMappingConfig({ milestoneStrategy: 'version' }),
      'ENG',
      options,
    );

    expect(plan.actions[0]).toMatchObject({
      kind: 'create_version',
      name: 'v1.2.0',
      releaseDate: '2026-03-31',
    });
    expect(issueActions(plan.actions)[0]?.versionActionId).toBe(plan.actions[0]?.id);
  });

  it('cria create_label apenas para labels ausentes no destino', () => {
    const model = makeModel({ labels: [{ name: 'bug' }, { name: 'novo' }] });
    const plan = buildPlan(
      model,
      makeCapabilities({ labels: ['bug'] }),
      makeMappingConfig(),
      'ENG',
      options,
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: 'create_label', name: 'novo' });
  });
});

describe('buildPlan — 2. resolução de tipo/prioridade/status', () => {
  it('traduz valores neutros para os nomes reais do destino', () => {
    const model = makeModel({
      issues: [makeIssue({ id: '1', type: 'bug', priority: 'high', status: 'in_progress' })],
    });

    const plan = buildPlan(model, makeCapabilities(), makeMappingConfig(), 'ENG', options);

    expect(issueActions(plan.actions)[0]).toMatchObject({
      issueType: 'Bug',
      priority: 'High',
      summary: 'Issue 1',
    });
    expect(plan.actions.at(-1)).toMatchObject({
      kind: 'transition_issue',
      targetStatus: 'In Progress',
    });
    expect(hasBlockingErrors(plan)).toBe(false);
  });

  it('não gera transição quando o status resolvido já é o inicial do workflow', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1', status: 'open' })] });
    const plan = buildPlan(model, makeCapabilities(), makeMappingConfig(), 'ENG', options);
    expect(kinds(plan.actions)).toEqual(['create_issue']);
  });

  it('reporta unmapped_value e descarta a issue quando o tipo não existe no destino', () => {
    const model = makeModel({
      issues: [makeIssue({ id: '1', type: 'bug' }), makeIssue({ id: '2', type: 'task' })],
    });
    const config = makeMappingConfig({
      issueTypes: { epic: 'Epic', story: 'Story', task: 'Task', bug: 'Defect', subtask: 'Sub-task' },
    });

    const plan = buildPlan(model, makeCapabilities(), config, 'ENG', options);

    expect(codes(plan, 'error')).toEqual(['unmapped_value']);
    expect(hasBlockingErrors(plan)).toBe(true);
    // A issue válida continua no plano: um item ruim não derruba o resto.
    expect(issueActions(plan.actions).map((action) => action.sourceRef.humanRef)).toEqual(['#2']);
  });

  it('reporta unmapped_value para prioridade e status inexistentes no destino', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1', priority: 'high', status: 'closed' })] });
    const config = makeMappingConfig({
      priorities: {
        highest: 'Highest',
        high: 'Urgente',
        medium: 'Medium',
        low: 'Low',
        lowest: 'Lowest',
      },
      statuses: { open: 'To Do', in_progress: 'In Progress', closed: 'Encerrado' },
    });

    const plan = buildPlan(model, makeCapabilities(), config, 'ENG', options);

    expect(codes(plan, 'error')).toEqual(['unmapped_value', 'unmapped_value']);
    // A issue continua sendo criada — sem prioridade e sem transição inválida.
    const [issue] = issueActions(plan.actions);
    expect(issue?.priority).toBeUndefined();
    expect(kinds(plan.actions)).toEqual(['create_issue']);
  });

  it('avisa quando o status resolvido não é alcançável pelo workflow', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1', status: 'closed' })] });
    const capabilities = makeCapabilities({
      workflow: { statuses: ['To Do', 'In Progress', 'Done'], transitions: { 'To Do': [] } },
    });

    const plan = buildPlan(model, capabilities, makeMappingConfig(), 'ENG', options);

    expect(codes(plan, 'warning')).toEqual(['unreachable_status']);
    // Ainda assim a transição é planejada: aviso, não bloqueio.
    expect(kinds(plan.actions)).toContain('transition_issue');
  });
});

describe('buildPlan — 3. campos obrigatórios', () => {
  it('reporta missing_required_field só para o que o Planner não sabe preencher', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1', type: 'bug' })] });
    const capabilities = makeCapabilities({
      requiredFieldsByIssueType: { Bug: ['Summary', 'description', 'customfield_10042'] },
    });

    const plan = buildPlan(model, capabilities, makeMappingConfig(), 'ENG', options);

    const errors = plan.findings.filter((finding) => finding.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('missing_required_field');
    expect(errors[0]?.message).toContain('customfield_10042');
  });

  it('considera preenchidos os campos derivados do modelo (labels, assignee, parent)', () => {
    const parent = makeIssue({ id: '1' });
    const child = makeIssue({
      id: '2',
      type: 'subtask',
      parentSourceRef: parent.sourceRef,
      labels: [{ name: 'infra' }],
      assignees: [{ displayName: 'Ana', email: 'ana@example.test' }],
    });
    const capabilities = makeCapabilities({
      requiredFieldsByIssueType: { 'Sub-task': ['labels', 'assignee', 'parent'] },
    });

    const plan = buildPlan(
      makeModel({ issues: [parent, child] }),
      capabilities,
      makeMappingConfig(),
      'ENG',
      options,
    );

    expect(plan.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });
});

describe('buildPlan — 4. ordenação', () => {
  it('ordena catálogo → issues (pais antes) → comentários/anexos/links/transições', () => {
    const milestone = makeMilestone('m1', 'Sprint 1');
    const parent = makeIssue({
      id: '1',
      milestone: milestone.sourceRef,
      comments: [makeComment('c1')],
      links: [{ type: 'relates_to', targetSourceRef: ref('issue', '2') }],
    });
    const child = makeIssue({
      id: '2',
      type: 'subtask',
      status: 'closed',
      parentSourceRef: parent.sourceRef,
      attachments: [
        {
          sourceRef: ref('attachment', 'a1'),
          filename: 'print.png',
          url: 'https://example.test/print.png',
          origin: 'inline_body',
        },
      ],
    });

    // Filho declarado ANTES do pai de propósito: o Planner deve reordenar.
    const model = makeModel({ milestones: [milestone], issues: [child, parent] });
    const plan = buildPlan(model, makeCapabilities(), makeMappingConfig(), 'ENG', options);

    expect(kinds(plan.actions)).toEqual([
      'create_epic',
      'create_issue',
      'create_issue',
      'create_comment',
      'create_attachment',
      'create_link',
      'transition_issue',
    ]);
    expect(issueActions(plan.actions).map((action) => action.sourceRef.humanRef)).toEqual([
      '#1',
      '#2',
    ]);
    const link = plan.actions.find((action) => action.kind === 'create_link');
    expect(link).toMatchObject({
      canonicalType: 'relates_to',
      dependsOn: [`issue:${parent.sourceRef.id}`, `issue:${child.sourceRef.id}`],
    });
  });

  it('deduplica links recíprocos em uma única ação', () => {
    const a = makeIssue({
      id: '1',
      links: [{ type: 'blocks', targetSourceRef: ref('issue', '2') }],
    });
    const b = makeIssue({
      id: '2',
      links: [{ type: 'blocked_by', targetSourceRef: ref('issue', '1') }],
    });

    const plan = buildPlan(
      makeModel({ issues: [a, b] }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    const links = plan.actions.filter((action) => action.kind === 'create_link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ canonicalType: 'blocks' });
  });
});

describe('buildPlan — 5. ciclos', () => {
  it('descarta apenas as issues do ciclo de hierarquia e mantém o resto do plano', () => {
    const a = makeIssue({ id: '1', parentSourceRef: ref('issue', '2') });
    const b = makeIssue({ id: '2', parentSourceRef: ref('issue', '1') });
    const c = makeIssue({ id: '3' });

    const plan = buildPlan(
      makeModel({ issues: [a, b, c] }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    const cycleFindings = plan.findings.filter((finding) => finding.code === 'dependency_cycle');
    expect(cycleFindings).toHaveLength(2);
    expect(cycleFindings.every((finding) => finding.severity === 'error')).toBe(true);
    expect(issueActions(plan.actions).map((action) => action.sourceRef.humanRef)).toEqual(['#3']);
  });

  it('trata ciclo de bloqueio como aviso e mantém as issues e os links', () => {
    const a = makeIssue({
      id: '1',
      links: [{ type: 'blocks', targetSourceRef: ref('issue', '2') }],
    });
    const b = makeIssue({
      id: '2',
      links: [{ type: 'blocks', targetSourceRef: ref('issue', '1') }],
    });

    const plan = buildPlan(
      makeModel({ issues: [a, b] }),
      makeCapabilities(),
      makeMappingConfig(),
      'ENG',
      options,
    );

    expect(codes(plan, 'warning')).toEqual(['dependency_cycle']);
    expect(hasBlockingErrors(plan)).toBe(false);
    expect(issueActions(plan.actions)).toHaveLength(2);
    expect(plan.actions.filter((action) => action.kind === 'create_link')).toHaveLength(2);
  });
});

describe('buildPlan — hierarquia', () => {
  it('descarta o épico quando a issue já tem pai direto (destino só aceita um)', () => {
    const milestone = makeMilestone('m1', 'Sprint 1');
    const parent = makeIssue({ id: '1' });
    const child = makeIssue({
      id: '2',
      type: 'subtask',
      parentSourceRef: parent.sourceRef,
      milestone: milestone.sourceRef,
    });

    const plan = buildPlan(
      makeModel({ milestones: [milestone], issues: [parent, child] }),
      makeCapabilities(),
      makeMappingConfig({ milestoneStrategy: 'epic' }),
      'ENG',
      options,
    );

    const childAction = issueActions(plan.actions).find(
      (action) => action.sourceRef.humanRef === '#2',
    );
    expect(childAction?.parentActionId).toBe(`issue:${parent.sourceRef.id}`);
    expect(childAction?.epicActionId).toBeUndefined();
    expect(childAction?.dependsOn).toEqual([`issue:${parent.sourceRef.id}`]);
    expect(codes(plan, 'info')).toEqual(['hierarchy_conflict']);
    expect(hasBlockingErrors(plan)).toBe(false);
  });
});

describe('buildPlan — 6. mapeamento default', () => {
  it('usa defaultPriority e reporta used_default_mapping', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1' })] });
    const plan = buildPlan(
      model,
      makeCapabilities(),
      makeMappingConfig({ defaultPriority: 'medium' }),
      'ENG',
      options,
    );

    expect(codes(plan, 'warning')).toEqual(['used_default_mapping']);
    expect(issueActions(plan.actions)[0]?.priority).toBe('Medium');
    expect(hasBlockingErrors(plan)).toBe(false);
  });

  it('deixa a issue sem prioridade quando não há default configurado', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1' })] });
    const plan = buildPlan(model, makeCapabilities(), makeMappingConfig(), 'ENG', options);

    expect(plan.findings).toEqual([]);
    expect(issueActions(plan.actions)[0]?.priority).toBeUndefined();
  });
});

describe('buildPlan — campos configurados', () => {
  const capabilitiesComCampo = () =>
    makeCapabilities({
      requiredFieldsByIssueType: { Bug: ['summary', 'customfield_10042'] },
      customFields: [{ id: 'customfield_10042', name: 'Severity', type: 'option' }],
    });

  it('mescla defaults com byIssueType, com o específico vencendo', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1', type: 'bug' })] });
    const plan = buildPlan(
      model,
      makeCapabilities(),
      makeMappingConfig({
        fields: {
          defaults: { customfield_10042: { value: 'Minor' }, customfield_10099: 'sempre' },
          byIssueType: { Bug: { customfield_10042: { value: 'Critical' } } },
        },
      }),
      'ENG',
      options,
    );

    expect(issueActions(plan.actions)[0]?.fields).toEqual({
      customfield_10042: { value: 'Critical' },
      customfield_10099: 'sempre',
    });
  });

  it('campo obrigatório do destino deixa de bloquear quando a config o preenche', () => {
    const model = makeModel({ issues: [makeIssue({ id: '1', type: 'bug' })] });

    const semConfig = buildPlan(model, capabilitiesComCampo(), makeMappingConfig(), 'ENG', options);
    expect(codes(semConfig, 'error')).toEqual(['missing_required_field']);

    const comConfig = buildPlan(
      model,
      capabilitiesComCampo(),
      makeMappingConfig({ fields: { defaults: { customfield_10042: { value: 'Major' } } } }),
      'ENG',
      options,
    );
    expect(hasBlockingErrors(comConfig)).toBe(false);
  });

  it('avisa uma única vez sobre custom field que não existe no destino', () => {
    const model = makeModel({
      issues: [makeIssue({ id: '1' }), makeIssue({ id: '2' })],
    });

    const plan = buildPlan(
      model,
      makeCapabilities(),
      makeMappingConfig({ fields: { defaults: { customfield_99999: 'x' } } }),
      'ENG',
      options,
    );

    expect(plan.findings.filter((finding) => finding.severity === 'warning')).toHaveLength(1);
    expect(plan.findings[0]?.message).toContain('customfield_99999');
  });

  it('valida campo obrigatório também no tipo usado para épicos', () => {
    const milestone = makeMilestone('m1', 'Sprint 1');
    const model = makeModel({ milestones: [milestone], issues: [] });
    const capabilities = makeCapabilities({
      requiredFieldsByIssueType: { Epic: ['summary', 'customfield_10077'] },
      customFields: [{ id: 'customfield_10077', name: 'Iniciativa', type: 'string' }],
    });

    const bloqueado = buildPlan(model, capabilities, makeMappingConfig(), 'ENG', options);
    expect(codes(bloqueado, 'error')).toEqual(['missing_required_field']);
    expect(bloqueado.findings[0]?.relatedSourceRef?.id).toBe(milestone.sourceRef.id);

    const liberado = buildPlan(
      model,
      capabilities,
      makeMappingConfig({ fields: { byIssueType: { Epic: { customfield_10077: 'PLAT' } } } }),
      'ENG',
      options,
    );
    expect(hasBlockingErrors(liberado)).toBe(false);
    expect(liberado.actions[0]).toMatchObject({
      kind: 'create_epic',
      fields: { customfield_10077: 'PLAT' },
    });
  });
});

describe('buildPlan — pureza', () => {
  it('é determinística: mesma entrada, mesmo plano', () => {
    const model = makeModel({
      milestones: [makeMilestone('m1', 'Sprint 1')],
      issues: [makeIssue({ id: '1', comments: [makeComment('c1')] })],
    });

    const first = buildPlan(model, makeCapabilities(), makeMappingConfig(), 'ENG', options);
    const second = buildPlan(model, makeCapabilities(), makeMappingConfig(), 'ENG', options);

    expect(first).toEqual(second);
    expect(first.generatedAt).toBe(GENERATED_AT);
    expect(first.targetProjectKey).toBe('ENG');
    expect(first.schemaVersion).toBe(1);
  });
});
