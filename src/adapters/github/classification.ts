import type { IssuePriority, IssueStatus, IssueType } from '../../core/models/common.js';

/**
 * GitHub has no type or priority — only labels. This classification maps
 * labels to neutral `IssueModel` values.
 *
 * It is ADAPTER configuration, not Planner configuration: the Planner maps neutral → target,
 * the adapter maps source → neutral. All keys are compared in lowercase.
 */
export interface LabelClassification {
  typeByLabel: Record<string, IssueType>;
  priorityByLabel: Record<string, IssuePriority>;
  /** Labels that indicate work in progress (open issue → `in_progress`). */
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

/** Precedence when an issue has more than one type label. */
const TYPE_PRECEDENCE: readonly IssueType[] = ['epic', 'subtask', 'bug', 'story', 'task'];

/** Highest to lowest: conflicting labels resolve to the highest. */
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
 * `closed` always wins. An open issue with an in-progress label becomes
 * `in_progress` — this is what lets the Planner generate the transition in the target.
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
