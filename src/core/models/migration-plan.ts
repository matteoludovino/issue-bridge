import { z } from 'zod';
import { LinkTypeSchema, SourceRefSchema } from './common.js';
import { IssueModelSchema } from './issue-model.js';

/**
 * Diagnostic codes emitted by the Planner.
 *  - `unmapped_value`: a mapping resolved to a value that does not exist in the target.
 *  - `missing_required_field`: the target requires a field the Planner cannot fill.
 *  - `dependency_cycle`: cycle detected in the hierarchy (error) or in blocking links (warning).
 *  - `used_default_mapping`: value missing in the source, filled with the config default.
 *  - `unreachable_status`: target status not reachable through the declared workflow.
 *  - `hierarchy_conflict`: the source expresses two parents and the target accepts only one.
 *  - `already_exists`: catalog item already exists in the target.
 *  - `not_migrated`: source data that this version does not carry over.
 */
export const PlanFindingCodeSchema = z.enum([
  'unmapped_value',
  'missing_required_field',
  'dependency_cycle',
  'used_default_mapping',
  'unreachable_status',
  'hierarchy_conflict',
  'already_exists',
  'not_migrated',
]);
export type PlanFindingCode = z.infer<typeof PlanFindingCodeSchema>;

export const PlanFindingSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  relatedSourceRef: SourceRefSchema.optional(),
  code: PlanFindingCodeSchema,
});
export type PlanFinding = z.infer<typeof PlanFindingSchema>;

/** Catalog actions: depend on nothing, run first. */
export const CreateEpicActionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('create_epic'),
  /** Source milestone that became this epic. */
  sourceRef: SourceRefSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** Extra fields for the epic type (includes required custom fields). */
  fields: z.record(z.string(), z.unknown()).default({}),
});

export const CreateVersionActionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('create_version'),
  sourceRef: SourceRefSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  releaseDate: z.string().optional(),
});

export const CreateComponentActionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('create_component'),
  name: z.string().min(1),
  description: z.string().optional(),
});

export const CreateLabelActionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('create_label'),
  name: z.string().min(1),
});

const DependentAction = {
  id: z.string().min(1),
  /** Ids of actions that must have completed before this one. */
  dependsOn: z.array(z.string()).default([]),
};

export const CreateIssueActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('create_issue'),
  sourceRef: SourceRefSchema,
  /** Type name in the TARGET, already resolved and validated against the capabilities. */
  issueType: z.string().min(1),
  summary: z.string(),
  description: z.string(),
  /** Priority name in the TARGET. Absent = do not set a priority. */
  priority: z.string().optional(),
  labels: z.array(z.string()).default([]),
  /** User identifiers in the target (email or displayName; the adapter resolves them). */
  assignees: z.array(z.string()).default([]),
  /** `create_epic` action whose result is this issue's parent epic. */
  epicActionId: z.string().optional(),
  /** `create_version` action to associate as the fix version. */
  versionActionId: z.string().optional(),
  /** `create_issue` action of the parent issue (hierarchy via `parentSourceRef`/`child_of`). */
  parentActionId: z.string().optional(),
  /** Extra fields keyed by target field id (includes custom fields). */
  fields: z.record(z.string(), z.unknown()).default({}),
});

export const CreateCommentActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('create_comment'),
  sourceRef: SourceRefSchema,
  issueActionId: z.string().min(1),
  body: z.string(),
});

export const CreateAttachmentActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('create_attachment'),
  sourceRef: SourceRefSchema,
  issueActionId: z.string().min(1),
  filename: z.string().min(1),
  /** URL in the source; the Executor/adapter downloads it at upload time. */
  url: z.string().url(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const CreateLinkActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('create_link'),
  /** Source issue on the left-hand side of the link. */
  sourceRef: SourceRefSchema,
  fromIssueActionId: z.string().min(1),
  toIssueActionId: z.string().min(1),
  /**
   * Canonical semantics. `TargetCapabilities` does not expose a link type catalog,
   * so translating to the actual name is the target adapter's responsibility.
   */
  canonicalType: LinkTypeSchema,
});

export const TransitionIssueActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('transition_issue'),
  sourceRef: SourceRefSchema,
  issueActionId: z.string().min(1),
  /** Name of the final status in the TARGET. */
  targetStatus: z.string().min(1),
});

export const PlanActionSchema = z.discriminatedUnion('kind', [
  CreateEpicActionSchema,
  CreateVersionActionSchema,
  CreateComponentActionSchema,
  CreateLabelActionSchema,
  CreateIssueActionSchema,
  CreateCommentActionSchema,
  CreateAttachmentActionSchema,
  CreateLinkActionSchema,
  TransitionIssueActionSchema,
]);
export type PlanAction = z.infer<typeof PlanActionSchema>;
export type PlanActionKind = PlanAction['kind'];

export type CreateEpicAction = z.infer<typeof CreateEpicActionSchema>;
export type CreateVersionAction = z.infer<typeof CreateVersionActionSchema>;
export type CreateComponentAction = z.infer<typeof CreateComponentActionSchema>;
export type CreateLabelAction = z.infer<typeof CreateLabelActionSchema>;
export type CreateIssueAction = z.infer<typeof CreateIssueActionSchema>;
export type CreateCommentAction = z.infer<typeof CreateCommentActionSchema>;
export type CreateAttachmentAction = z.infer<typeof CreateAttachmentActionSchema>;
export type CreateLinkAction = z.infer<typeof CreateLinkActionSchema>;
export type TransitionIssueAction = z.infer<typeof TransitionIssueActionSchema>;

/**
 * Planner output: a complete, ordered and serializable description of what will
 * be written to the target. `actions` is already topologically sorted — `dependsOn`
 * exists so the Executor can resolve references, not to reorder.
 */
export const MigrationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  targetProjectKey: z.string().min(1),
  model: IssueModelSchema,
  actions: z.array(PlanActionSchema),
  findings: z.array(PlanFindingSchema).default([]),
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

/** `true` if there is any `error` finding — the Executor refuses to run the plan. */
export function hasBlockingErrors(plan: MigrationPlan): boolean {
  return plan.findings.some((finding) => finding.severity === 'error');
}

/** Catalog actions have no `dependsOn`; helper to discriminate without repeating the list. */
export function isCatalogAction(
  action: PlanAction,
): action is CreateEpicAction | CreateVersionAction | CreateComponentAction | CreateLabelAction {
  return (
    action.kind === 'create_epic' ||
    action.kind === 'create_version' ||
    action.kind === 'create_component' ||
    action.kind === 'create_label'
  );
}
