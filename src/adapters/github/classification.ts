import type { IssuePriority, IssueStatus, IssueType } from '../../core/models/common.js';

/**
 * O GitHub não tem tipo nem prioridade — só labels. Esta classificação traduz
 * labels em valores neutros do `IssueModel`.
 *
 * É configuração DO ADAPTER, não do Planner: o Planner traduz neutro → destino,
 * o adapter traduz origem → neutro. Todas as chaves são comparadas em minúsculas.
 */
export interface LabelClassification {
  typeByLabel: Record<string, IssueType>;
  priorityByLabel: Record<string, IssuePriority>;
  /** Labels que indicam trabalho em andamento (issue aberta → `in_progress`). */
  inProgressLabels: string[];
  defaultType: IssueType;
}

export const DEFAULT_LABEL_CLASSIFICATION: LabelClassification = {
  typeByLabel: {
    epic: 'epic',
    bug: 'bug',
    defect: 'bug',
    regression: 'bug',
    story: 'story',
    feature: 'story',
    enhancement: 'story',
    'feature request': 'story',
    subtask: 'subtask',
    'sub-task': 'subtask',
    task: 'task',
    chore: 'task',
  },
  priorityByLabel: {
    p0: 'highest',
    p1: 'high',
    p2: 'medium',
    p3: 'low',
    p4: 'lowest',
    blocker: 'highest',
    critical: 'highest',
    urgent: 'highest',
    'priority: critical': 'highest',
    'priority: high': 'high',
    'priority: medium': 'medium',
    'priority: low': 'low',
  },
  inProgressLabels: ['in progress', 'in-progress', 'wip', 'doing', 'em andamento'],
  defaultType: 'task',
};

/** Precedência quando a issue tem mais de uma label de tipo. */
const TYPE_PRECEDENCE: readonly IssueType[] = ['epic', 'subtask', 'bug', 'story', 'task'];

/** Da mais alta para a mais baixa: labels conflitantes resolvem pela maior. */
const PRIORITY_PRECEDENCE: readonly IssuePriority[] = [
  'highest',
  'high',
  'medium',
  'low',
  'lowest',
];

export function classifyType(labels: string[], config: LabelClassification): IssueType {
  const matched = new Set<IssueType>();
  for (const label of labels) {
    const type = config.typeByLabel[label.toLowerCase()];
    if (type !== undefined) matched.add(type);
  }
  return TYPE_PRECEDENCE.find((type) => matched.has(type)) ?? config.defaultType;
}

export function classifyPriority(
  labels: string[],
  config: LabelClassification,
): IssuePriority | undefined {
  const matched = new Set<IssuePriority>();
  for (const label of labels) {
    const priority = config.priorityByLabel[label.toLowerCase()];
    if (priority !== undefined) matched.add(priority);
  }
  return PRIORITY_PRECEDENCE.find((priority) => matched.has(priority));
}

/**
 * `closed` sempre vence. Issue aberta com label de andamento vira
 * `in_progress` — é o que permite o Planner gerar a transição no destino.
 */
export function classifyStatus(
  state: 'open' | 'closed',
  labels: string[],
  config: LabelClassification,
): IssueStatus {
  if (state === 'closed') return 'closed';
  const normalized = labels.map((label) => label.toLowerCase());
  const inProgress = config.inProgressLabels.some((label) =>
    normalized.includes(label.toLowerCase()),
  );
  return inProgress ? 'in_progress' : 'open';
}
