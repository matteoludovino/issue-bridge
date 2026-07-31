import { z } from 'zod';
import { LinkTypeSchema, SourceRefSchema } from './common.js';
import { IssueModelSchema } from './issue-model.js';

/**
 * Códigos de diagnóstico emitidos pelo Planner.
 *  - `unmapped_value`: mapeamento resolveu para um valor que não existe no destino.
 *  - `missing_required_field`: destino exige campo que o Planner não sabe preencher.
 *  - `dependency_cycle`: ciclo detectado em hierarquia (error) ou em bloqueios (warning).
 *  - `used_default_mapping`: valor ausente na origem, preenchido com o default da config.
 *  - `unreachable_status`: status de destino não alcançável pelo workflow declarado.
 *  - `hierarchy_conflict`: origem expressa dois pais e o destino só aceita um.
 *  - `already_exists`: item de catálogo já existe no destino.
 *  - `not_migrated`: dado da origem que esta versão não transporta.
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

/** Ações de catálogo: não dependem de nada, rodam primeiro. */
export const CreateEpicActionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('create_epic'),
  /** Milestone de origem que virou este épico. */
  sourceRef: SourceRefSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** Campos extras do tipo épico (inclui custom fields obrigatórios). */
  fields: z.record(z.unknown()).default({}),
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
  /** Ids de ações que precisam ter concluído antes desta. */
  dependsOn: z.array(z.string()).default([]),
};

export const CreateIssueActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('create_issue'),
  sourceRef: SourceRefSchema,
  /** Nome do tipo no DESTINO, já resolvido e validado contra as capabilities. */
  issueType: z.string().min(1),
  summary: z.string(),
  description: z.string(),
  /** Nome da prioridade no DESTINO. Ausente = não definir prioridade. */
  priority: z.string().optional(),
  labels: z.array(z.string()).default([]),
  /** Identificadores de usuário no destino (e-mail ou displayName; o adapter resolve). */
  assignees: z.array(z.string()).default([]),
  /** Ação `create_epic` cujo resultado é o épico-pai desta issue. */
  epicActionId: z.string().optional(),
  /** Ação `create_version` a associar como versão de correção. */
  versionActionId: z.string().optional(),
  /** Ação `create_issue` da issue-pai (hierarquia via `parentSourceRef`/`child_of`). */
  parentActionId: z.string().optional(),
  /** Campos extras por id de campo do destino (inclui custom fields). */
  fields: z.record(z.unknown()).default({}),
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
  /** URL na origem; o Executor/adapter baixa no momento do upload. */
  url: z.string().url(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const CreateLinkActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('create_link'),
  /** Issue de origem do lado esquerdo do link. */
  sourceRef: SourceRefSchema,
  fromIssueActionId: z.string().min(1),
  toIssueActionId: z.string().min(1),
  /**
   * Semântica canônica. `TargetCapabilities` não expõe catálogo de tipos de link,
   * então a tradução para o nome real é responsabilidade do adapter de destino.
   */
  canonicalType: LinkTypeSchema,
});

export const TransitionIssueActionSchema = z.object({
  ...DependentAction,
  kind: z.literal('transition_issue'),
  sourceRef: SourceRefSchema,
  issueActionId: z.string().min(1),
  /** Nome do status final no DESTINO. */
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
 * Saída do Planner: descrição completa, ordenada e serializável do que será
 * escrito no destino. `actions` já vem topologicamente ordenada — `dependsOn`
 * existe para o Executor resolver referências, não para reordenar.
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

/** `true` se existe qualquer finding `error` — o Executor recusa executar o plano. */
export function hasBlockingErrors(plan: MigrationPlan): boolean {
  return plan.findings.some((finding) => finding.severity === 'error');
}

/** Ações de catálogo não têm `dependsOn`; helper para discriminar sem repetir a lista. */
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
