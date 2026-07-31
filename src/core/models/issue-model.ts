import { z } from 'zod';
import {
  IssuePrioritySchema,
  IssueStatusSchema,
  IssueTypeSchema,
  LinkTypeSchema,
  PersonSchema,
  SourceRefSchema,
} from './common.js';

export const LabelSchema = z.object({
  name: z.string().min(1),
  /** Cor em hex sem `#`, quando a origem fornecer. */
  color: z.string().optional(),
  description: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;

/**
 * Agrupamento temporal de issues. O Planner materializa como Epic ou Version
 * conforme `MappingConfig.milestoneStrategy`.
 */
export const MilestoneSchema = z.object({
  sourceRef: SourceRefSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  state: z.enum(['open', 'closed']),
  dueOn: z.string().optional(),
  closedAt: z.string().optional(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

/**
 * Anexo de uma issue ou comentário.
 *
 * `origin` distingue os dois caminhos de descoberta:
 *  - `api`: veio de um endpoint estruturado de anexos;
 *  - `inline_body`: a URL foi extraída por parsing do markdown (imagem colada).
 *
 * `sourceRef` é obrigatório mesmo para `inline_body` — o adapter sintetiza um id
 * determinístico (ex.: `github:acme/api:attachment:123#inline-0`) para que a
 * idempotência do Executor funcione.
 */
export const AttachmentSchema = z.object({
  sourceRef: SourceRefSchema,
  filename: z.string().min(1),
  /** URL de download na origem; pode exigir autenticação. */
  url: z.string().url(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  origin: z.enum(['api', 'inline_body']),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const CommentSchema = z.object({
  sourceRef: SourceRefSchema,
  author: PersonSchema,
  /** Corpo em markdown da origem; conversão de formato é papel do adapter de destino. */
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  attachments: z.array(AttachmentSchema).default([]),
});
export type Comment = z.infer<typeof CommentSchema>;

export const IssueLinkSchema = z.object({
  type: LinkTypeSchema,
  /** Issue do outro lado da relação, sempre no espaço da ORIGEM. */
  targetSourceRef: SourceRefSchema,
});
export type IssueLink = z.infer<typeof IssueLinkSchema>;

export const ChecklistItemSchema = z.object({
  text: z.string(),
  checked: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

/**
 * Issue no modelo intermediário — a única linguagem que o core entende.
 * Nenhum campo cita GitHub ou Jira.
 */
export const IssueSchema = z.object({
  sourceRef: SourceRefSchema,
  title: z.string(),
  body: z.string(),
  type: IssueTypeSchema,
  status: IssueStatusSchema,
  priority: IssuePrioritySchema.optional(),
  labels: z.array(LabelSchema).default([]),
  /** `sourceRef.id` do milestone ao qual a issue pertence. */
  milestone: SourceRefSchema.optional(),
  assignees: z.array(PersonSchema).default([]),
  author: PersonSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  closedAt: z.string().optional(),
  comments: z.array(CommentSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  links: z.array(IssueLinkSchema).default([]),
  checklist: z.array(ChecklistItemSchema).default([]),
  parentSourceRef: SourceRefSchema.optional(),
  /**
   * Payload bruto da origem. NUNCA lido por lógica de negócio — existe apenas
   * para relatórios e auditoria.
   */
  raw: z.record(z.unknown()).optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

/** Artefato completo de uma extração: o que `export` grava e `analyze`/`apply` consomem. */
export const IssueModelSchema = z.object({
  source: z.object({
    platform: z.string().min(1),
    /** Escopo extraído, no formato da plataforma (`owner/repo`). */
    identifier: z.string().min(1),
    extractedAt: z.string(),
  }),
  issues: z.array(IssueSchema),
  milestones: z.array(MilestoneSchema).default([]),
  labels: z.array(LabelSchema).default([]),
});
export type IssueModel = z.infer<typeof IssueModelSchema>;
