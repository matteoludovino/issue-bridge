import {
  BLOCKING_LINK_TYPES,
  type IssuePriority,
  type LinkType,
  type SourceRef,
} from '../models/common.js';
import type { Issue, IssueModel } from '../models/issue-model.js';
import type {
  CreateAttachmentAction,
  CreateCommentAction,
  CreateEpicAction,
  CreateIssueAction,
  CreateLabelAction,
  CreateLinkAction,
  CreateVersionAction,
  MigrationPlan,
  PlanAction,
  PlanFinding,
  TransitionIssueAction,
} from '../models/migration-plan.js';
import type { TargetCapabilities } from '../ports/target-adapter.js';
import { addEdge, findCyclicComponents, type DirectedGraph } from './graph.js';
import { resolveFieldsFor, type MappingConfig } from './mapping-config.js';

export interface BuildPlanOptions {
  /**
   * Timestamp written to `generatedAt`. Pass it in tests so that `buildPlan` is
   * 100% deterministic; when omitted, the system clock is used.
   */
  generatedAt?: string;
}

/** Deterministic action ids: the same model always produces the same plan. */
const actionId = {
  epic: (milestoneRefId: string) => `epic:${milestoneRefId}`,
  version: (milestoneRefId: string) => `version:${milestoneRefId}`,
  label: (name: string) => `label:${name}`,
  issue: (issueRefId: string) => `issue:${issueRefId}`,
  comment: (commentRefId: string) => `comment:${commentRefId}`,
  attachment: (attachmentRefId: string) => `attachment:${attachmentRefId}`,
  link: (from: string, type: LinkType, to: string) => `link:${from}|${type}|${to}`,
  /**
   * The target status is part of the id — and therefore of the idempotency key.
   * Without it, an issue whose status changed in the source after the first
   * migration would have its transition skipped forever on `sync`.
   */
  transition: (issueRefId: string, targetStatus: string) =>
    `transition:${issueRefId}:${targetStatus}`,
};

/**
 * Fields the Planner always fills when creating an issue. Compared in
 * normalized form against `capabilities.requiredFieldsByIssueType`, which may use
 * names or ids (`Summary`, `summary`, `issueType`).
 */
const ALWAYS_PROVIDED_FIELDS = ['project', 'issuetype', 'summary', 'description'];

const normalizeFieldId = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Builds the migration plan. PURE function: no network, no fs, no console.
 *
 * What it deliberately does NOT do:
 *  - it does not emit `create_component`: no `IssueModel` concept maps to a
 *    target component (that would come from the config, in a future phase);
 *  - it does not invent custom field values: they come only from
 *    `mappings.fields` (defaults, then per issue type), so a required field
 *    with no configured value shows up as `missing_required_field`.
 */
export function buildPlan(
  model: IssueModel,
  capabilities: TargetCapabilities,
  config: MappingConfig,
  targetProjectKey: string,
  options: BuildPlanOptions = {},
): MigrationPlan {
  const findings: PlanFinding[] = [];
  const issueByRefId = new Map(model.issues.map((issue) => [issue.sourceRef.id, issue]));

  // The field config is validated ONCE against the target — doing it per issue
  // would emit the same warning hundreds of times.
  validateConfiguredFields(config, capabilities, findings);

  // ─── 1. Milestones → epics or versions ────────────────────────────────────
  const catalogActions: PlanAction[] = [];
  const milestoneActionByRefId = new Map<string, string>();
  const epicIssueType = config.issueTypes.epic;

  for (const milestone of model.milestones) {
    if (config.milestoneStrategy === 'epic') {
      const epicFields = resolveFieldsFor(config, epicIssueType);
      const epic: CreateEpicAction = {
        id: actionId.epic(milestone.sourceRef.id),
        kind: 'create_epic',
        sourceRef: milestone.sourceRef,
        name: milestone.title,
        fields: epicFields,
        ...(milestone.description === undefined ? {} : { description: milestone.description }),
      };
      catalogActions.push(epic);
      milestoneActionByRefId.set(milestone.sourceRef.id, epic.id);

      // An epic is created as an issue in the target, so it is subject to the same
      // required-field rules — validating here avoids a 400 during `apply`.
      if (!capabilities.issueTypes.includes(epicIssueType)) {
        findings.push({
          severity: 'error',
          code: 'unmapped_value',
          message: `Milestone strategy is "epic", but issue type "${epicIssueType}" does not exist in the target.`,
          relatedSourceRef: milestone.sourceRef,
        });
      } else {
        checkRequiredFields({
          capabilities,
          targetIssueType: epicIssueType,
          provided: providedFieldIds({ fields: epicFields }),
          findings,
          sourceRef: milestone.sourceRef,
        });
      }
      continue;
    }

    const version: CreateVersionAction = {
      id: actionId.version(milestone.sourceRef.id),
      kind: 'create_version',
      sourceRef: milestone.sourceRef,
      name: milestone.title,
      ...(milestone.description === undefined ? {} : { description: milestone.description }),
      ...(milestone.dueOn === undefined ? {} : { releaseDate: milestone.dueOn }),
    };
    catalogActions.push(version);
    milestoneActionByRefId.set(milestone.sourceRef.id, version.id);

    if (capabilities.versions.includes(milestone.title)) {
      findings.push({
        severity: 'info',
        code: 'already_exists',
        message: `Version "${milestone.title}" already exists in the target; the adapter should reconcile instead of recreating it.`,
        relatedSourceRef: milestone.sourceRef,
      });
    }
  }

  // ─── Labels missing in the target ─────────────────────────────────────────
  for (const label of model.labels) {
    if (capabilities.labels.includes(label.name)) continue;
    const action: CreateLabelAction = {
      id: actionId.label(label.name),
      kind: 'create_label',
      name: label.name,
    };
    catalogActions.push(action);
  }

  // ─── 5. Cycles ────────────────────────────────────────────────────────────
  // Hierarchy defines creation order: a cycle here is fatal.
  const hierarchy: DirectedGraph = new Map();
  for (const issue of model.issues) {
    const id = issue.sourceRef.id;
    if (issue.parentSourceRef !== undefined && issueByRefId.has(issue.parentSourceRef.id)) {
      addEdge(hierarchy, id, issue.parentSourceRef.id);
    }
    for (const link of issue.links) {
      const otherId = link.targetSourceRef.id;
      if (!issueByRefId.has(otherId)) continue;
      if (link.type === 'child_of') addEdge(hierarchy, id, otherId);
      if (link.type === 'parent_of') addEdge(hierarchy, otherId, id);
    }
  }

  const droppedIssueIds = new Set<string>();
  for (const component of findCyclicComponents(hierarchy)) {
    for (const id of component) {
      const issue = issueByRefId.get(id);
      if (issue === undefined) continue;
      droppedIssueIds.add(id);
      findings.push({
        severity: 'error',
        code: 'dependency_cycle',
        message: `Hierarchy cycle between [${component.join(', ')}]. This issue was dropped from the plan; the others are unaffected.`,
        relatedSourceRef: issue.sourceRef,
      });
    }
  }

  // Blocking links do NOT affect the order (links are created after all issues),
  // so a cycle here is only a warning — dropping issues would lose data.
  const blocking: DirectedGraph = new Map();
  for (const issue of model.issues) {
    for (const link of issue.links) {
      if (!BLOCKING_LINK_TYPES.includes(link.type)) continue;
      const otherId = link.targetSourceRef.id;
      if (!issueByRefId.has(otherId)) continue;
      if (link.type === 'blocks') addEdge(blocking, otherId, issue.sourceRef.id);
      else addEdge(blocking, issue.sourceRef.id, otherId);
    }
  }
  for (const component of findCyclicComponents(blocking)) {
    findings.push({
      severity: 'warning',
      code: 'dependency_cycle',
      message: `Blocking cycle between [${component.join(', ')}]. The links will still be created, but review the dependency in the source.`,
    });
  }

  // ─── 2. Invalid types drop the issue before any other decision ────────────
  for (const issue of model.issues) {
    if (droppedIssueIds.has(issue.sourceRef.id)) continue;
    const targetType = config.issueTypes[issue.type];
    if (capabilities.issueTypes.includes(targetType)) continue;
    droppedIssueIds.add(issue.sourceRef.id);
    findings.push({
      severity: 'error',
      code: 'unmapped_value',
      message: `Type "${issue.type}" maps to "${targetType}", which does not exist in the target. The issue was dropped from the plan.`,
      relatedSourceRef: issue.sourceRef,
    });
  }

  // ─── Per-issue actions ────────────────────────────────────────────────────
  const issueActions: CreateIssueAction[] = [];
  const commentActions: CreateCommentAction[] = [];
  const attachmentActions: CreateAttachmentAction[] = [];
  const transitionActions: TransitionIssueAction[] = [];
  const initialStatus = capabilities.workflow.statuses[0];

  for (const issue of model.issues) {
    if (droppedIssueIds.has(issue.sourceRef.id)) continue;

    const targetType = config.issueTypes[issue.type];
    const priority = resolvePriority(issue, config, capabilities, findings);
    const targetStatus = config.statuses[issue.status];

    const parentRefId = resolveParentRefId(issue);
    const parentActionId =
      parentRefId !== undefined && !droppedIssueIds.has(parentRefId) && issueByRefId.has(parentRefId)
        ? actionId.issue(parentRefId)
        : undefined;

    const milestoneActionId =
      issue.milestone === undefined
        ? undefined
        : milestoneActionByRefId.get(issue.milestone.id);
    const versionActionId = config.milestoneStrategy === 'version' ? milestoneActionId : undefined;
    let epicActionId = config.milestoneStrategy === 'epic' ? milestoneActionId : undefined;

    // Targets with a single hierarchy field (Jira's `parent`) cannot take both a
    // direct parent AND an epic. The direct parent wins: it is the more specific relationship.
    if (epicActionId !== undefined && parentActionId !== undefined) {
      findings.push({
        severity: 'info',
        code: 'hierarchy_conflict',
        message: `Issue has both a direct parent and a milestone mapped to an epic; the epic was dropped because the target accepts a single parent.`,
        relatedSourceRef: issue.sourceRef,
      });
      epicActionId = undefined;
    }

    const labels = issue.labels.map((label) => label.name);
    const assignees = issue.assignees.map((person) => person.email ?? person.displayName);

    // ─── 3. Required target fields ─────────────────────────────────────────
    const issueFields = resolveFieldsFor(config, targetType);
    checkRequiredFields({
      capabilities,
      targetIssueType: targetType,
      provided: providedFieldIds({
        fields: issueFields,
        hasPriority: priority !== undefined,
        hasLabels: labels.length > 0,
        hasAssignee: assignees.length > 0,
        hasParent: parentActionId !== undefined || epicActionId !== undefined,
        hasVersion: versionActionId !== undefined,
      }),
      findings,
      sourceRef: issue.sourceRef,
    });

    if (issue.checklist.length > 0) {
      findings.push({
        severity: 'info',
        code: 'not_migrated',
        message: `Issue has ${String(issue.checklist.length)} checklist item(s); the checklist survives only inside the migrated body.`,
        relatedSourceRef: issue.sourceRef,
      });
    }

    const issueAction: CreateIssueAction = {
      id: actionId.issue(issue.sourceRef.id),
      kind: 'create_issue',
      dependsOn: [epicActionId, versionActionId, parentActionId].filter(
        (value): value is string => value !== undefined,
      ),
      sourceRef: issue.sourceRef,
      issueType: targetType,
      summary: issue.title,
      description: issue.body,
      labels,
      assignees,
      fields: issueFields,
      ...(priority === undefined ? {} : { priority }),
      ...(epicActionId === undefined ? {} : { epicActionId }),
      ...(versionActionId === undefined ? {} : { versionActionId }),
      ...(parentActionId === undefined ? {} : { parentActionId }),
    };
    issueActions.push(issueAction);

    for (const comment of issue.comments) {
      commentActions.push({
        id: actionId.comment(comment.sourceRef.id),
        kind: 'create_comment',
        dependsOn: [issueAction.id],
        sourceRef: comment.sourceRef,
        issueActionId: issueAction.id,
        body: comment.body,
      });
    }

    // Comment attachments are also attached to the issue: most targets do not
    // support attachments on comments.
    const allAttachments = [
      ...issue.attachments,
      ...issue.comments.flatMap((comment) => comment.attachments),
    ];
    for (const attachment of allAttachments) {
      attachmentActions.push({
        id: actionId.attachment(attachment.sourceRef.id),
        kind: 'create_attachment',
        dependsOn: [issueAction.id],
        sourceRef: attachment.sourceRef,
        issueActionId: issueAction.id,
        filename: attachment.filename,
        url: attachment.url,
        ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
        ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
      });
    }

    if (!capabilities.workflow.statuses.includes(targetStatus)) {
      findings.push({
        severity: 'error',
        code: 'unmapped_value',
        message: `Status "${issue.status}" maps to "${targetStatus}", which does not exist in the target workflow.`,
        relatedSourceRef: issue.sourceRef,
      });
    } else if (initialStatus !== undefined && targetStatus !== initialStatus) {
      if (!isStatusReachable(capabilities.workflow.transitions, initialStatus, targetStatus)) {
        findings.push({
          severity: 'warning',
          code: 'unreachable_status',
          message: `Status "${targetStatus}" is not reachable from "${initialStatus}" through the declared transitions; the transition will be attempted anyway.`,
          relatedSourceRef: issue.sourceRef,
        });
      }
      transitionActions.push({
        id: actionId.transition(issue.sourceRef.id, targetStatus),
        kind: 'transition_issue',
        dependsOn: [issueAction.id],
        sourceRef: issue.sourceRef,
        issueActionId: issueAction.id,
        targetStatus,
      });
    }
  }

  // ─── Non-hierarchical links, deduplicated ─────────────────────────────────
  const linkActions = buildLinkActions(model.issues, droppedIssueIds, issueByRefId);

  // ─── 4. Final order: catalog → issues (parents first) → children ──────────
  const actions: PlanAction[] = [
    ...catalogActions,
    ...orderIssueActions(issueActions),
    ...commentActions,
    ...attachmentActions,
    ...linkActions,
    ...transitionActions,
  ];

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    targetProjectKey,
    model,
    actions,
    findings,
  };
}

interface ProvidedFieldsInput {
  fields: Record<string, unknown>;
  hasPriority?: boolean;
  hasLabels?: boolean;
  hasAssignee?: boolean;
  hasParent?: boolean;
  hasVersion?: boolean;
}

/** (Normalized) ids of the fields the Planner will actually fill. */
function providedFieldIds(input: ProvidedFieldsInput): Set<string> {
  const provided = new Set(ALWAYS_PROVIDED_FIELDS);
  if (input.hasPriority === true) provided.add('priority');
  if (input.hasLabels === true) provided.add('labels');
  if (input.hasAssignee === true) {
    provided.add('assignee');
    provided.add('assignees');
  }
  if (input.hasParent === true) {
    provided.add('parent');
    provided.add('epiclink');
  }
  if (input.hasVersion === true) {
    provided.add('fixversions');
    provided.add('versions');
  }
  for (const fieldId of Object.keys(input.fields)) provided.add(normalizeFieldId(fieldId));
  return provided;
}

function checkRequiredFields(input: {
  capabilities: TargetCapabilities;
  targetIssueType: string;
  provided: Set<string>;
  findings: PlanFinding[];
  sourceRef: SourceRef;
}): void {
  const required = input.capabilities.requiredFieldsByIssueType[input.targetIssueType] ?? [];
  for (const fieldId of required) {
    if (input.provided.has(normalizeFieldId(fieldId))) continue;
    input.findings.push({
      severity: 'error',
      code: 'missing_required_field',
      message: `Target requires field "${fieldId}" for type "${input.targetIssueType}" and no value is mapped. Set one under mappings.fields.`,
      relatedSourceRef: input.sourceRef,
    });
  }
}

/**
 * Warns when the config references a custom field the target does not declare —
 * usually a typo in the id or a config copied from another project.
 * Standard fields (`summary`, `duedate`) do not appear in `customFields`, so only
 * `customfield_*` can be checked.
 */
function validateConfiguredFields(
  config: MappingConfig,
  capabilities: TargetCapabilities,
  findings: PlanFinding[],
): void {
  const known = new Set(capabilities.customFields.map((field) => field.id));
  const configured = new Set<string>([
    ...Object.keys(config.fields?.defaults ?? {}),
    ...Object.values(config.fields?.byIssueType ?? {}).flatMap((byType) => Object.keys(byType)),
  ]);

  for (const fieldId of [...configured].sort()) {
    if (!fieldId.startsWith('customfield_') || known.has(fieldId)) continue;
    findings.push({
      severity: 'warning',
      code: 'unmapped_value',
      message: `Field "${fieldId}" is configured under mappings.fields but does not exist in the target; it will be sent and most likely rejected.`,
    });
  }
}

function resolvePriority(
  issue: Issue,
  config: MappingConfig,
  capabilities: TargetCapabilities,
  findings: PlanFinding[],
): string | undefined {
  const neutral: IssuePriority | undefined = issue.priority ?? config.defaultPriority;

  if (issue.priority === undefined && config.defaultPriority !== undefined) {
    findings.push({
      severity: 'warning',
      code: 'used_default_mapping',
      message: `Issue has no priority in the source; applying the default "${config.defaultPriority}".`,
      relatedSourceRef: issue.sourceRef,
    });
  }

  if (neutral === undefined) return undefined;

  const mapped = config.priorities[neutral];
  if (capabilities.priorities.includes(mapped)) return mapped;

  findings.push({
    severity: 'error',
    code: 'unmapped_value',
    message: `Priority "${neutral}" maps to "${mapped}", which does not exist in the target.`,
    relatedSourceRef: issue.sourceRef,
  });
  return undefined;
}

/** Explicit hierarchy (`parentSourceRef`) takes precedence over a `child_of` link. */
function resolveParentRefId(issue: Issue): string | undefined {
  if (issue.parentSourceRef !== undefined) return issue.parentSourceRef.id;
  return issue.links.find((link) => link.type === 'child_of')?.targetSourceRef.id;
}

function isStatusReachable(
  transitions: Record<string, string[]>,
  from: string,
  to: string,
): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of transitions[current] ?? []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Converts links into actions, skipping hierarchy (already resolved via
 * `parentActionId`) and normalizing reciprocal pairs so the same link is not
 * created twice (`A blocks B` + `B blocked_by A`).
 */
function buildLinkActions(
  issues: Issue[],
  droppedIssueIds: Set<string>,
  issueByRefId: Map<string, Issue>,
): CreateLinkAction[] {
  const seen = new Set<string>();
  const actions: CreateLinkAction[] = [];

  for (const issue of issues) {
    if (droppedIssueIds.has(issue.sourceRef.id)) continue;
    for (const link of issue.links) {
      const otherId = link.targetSourceRef.id;
      if (droppedIssueIds.has(otherId) || !issueByRefId.has(otherId)) continue;

      const canonical = canonicalizeLink(issue.sourceRef.id, otherId, link.type);
      if (canonical === null) continue;

      const id = actionId.link(canonical.from, canonical.type, canonical.to);
      if (seen.has(id)) continue;
      seen.add(id);

      const fromIssue = issueByRefId.get(canonical.from);
      if (fromIssue === undefined) continue;

      actions.push({
        id,
        kind: 'create_link',
        dependsOn: [actionId.issue(canonical.from), actionId.issue(canonical.to)],
        sourceRef: fromIssue.sourceRef,
        fromIssueActionId: actionId.issue(canonical.from),
        toIssueActionId: actionId.issue(canonical.to),
        canonicalType: canonical.type,
      });
    }
  }

  return actions;
}

function canonicalizeLink(
  issueId: string,
  otherId: string,
  type: LinkType,
): { from: string; to: string; type: LinkType } | null {
  switch (type) {
    case 'parent_of':
    case 'child_of':
      return null;
    case 'blocked_by':
      return { from: otherId, to: issueId, type: 'blocks' };
    case 'duplicated_by':
      return { from: otherId, to: issueId, type: 'duplicates' };
    case 'blocks':
    case 'duplicates':
      return { from: issueId, to: otherId, type };
    case 'relates_to': {
      // Symmetric: sorting the pair makes deduplication stable.
      const [from, to] = [issueId, otherId].sort();
      if (from === undefined || to === undefined) return null;
      return { from, to, type: 'relates_to' };
    }
  }
}

/** Orders issues so every parent comes before its children. The graph is already acyclic. */
function orderIssueActions(actions: CreateIssueAction[]): CreateIssueAction[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const visited = new Set<string>();
  const ordered: CreateIssueAction[] = [];

  const visit = (action: CreateIssueAction): void => {
    if (visited.has(action.id)) return;
    visited.add(action.id);
    const parentId = action.parentActionId;
    if (parentId !== undefined) {
      const parent = byId.get(parentId);
      if (parent !== undefined) visit(parent);
    }
    ordered.push(action);
  };

  for (const action of actions) visit(action);
  return ordered;
}
