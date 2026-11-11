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
  /** Hex color without `#`, when the source provides one. */
  color: z.string().optional(),
  description: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;

/**
 * Time-based grouping of issues. The Planner materializes it as an Epic or a
 * Version according to `MappingConfig.milestoneStrategy`.
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
 * Attachment of an issue or comment.
 *
 * `origin` distinguishes the two discovery paths:
 *  - `api`: came from a structured attachments endpoint;
 *  - `inline_body`: the URL was extracted by parsing the markdown (pasted image).
 *
 * `sourceRef` is required even for `inline_body` — the adapter synthesizes a
 * deterministic id (e.g. `github:acme/api:attachment:123#inline-0`) so that the
 * Executor's idempotency works.
 */
export const AttachmentSchema = z.object({
  sourceRef: SourceRefSchema,
  filename: z.string().min(1),
  /** Download URL in the source; may require authentication. */
  url: z.string().url(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  origin: z.enum(['api', 'inline_body']),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const CommentSchema = z.object({
  sourceRef: SourceRefSchema,
  author: PersonSchema,
  /** Body in the source's markdown; format conversion is the target adapter's job. */
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  attachments: z.array(AttachmentSchema).default([]),
});
export type Comment = z.infer<typeof CommentSchema>;

export const IssueLinkSchema = z.object({
  type: LinkTypeSchema,
  /** Issue on the other side of the relationship, always in the SOURCE namespace. */
  targetSourceRef: SourceRefSchema,
});
export type IssueLink = z.infer<typeof IssueLinkSchema>;

export const ChecklistItemSchema = z.object({
  text: z.string(),
  checked: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

/**
 * Issue in the intermediate model — the only language the core understands.
 * No field mentions GitHub or Jira.
 */
export const IssueSchema = z.object({
  sourceRef: SourceRefSchema,
  title: z.string(),
  body: z.string(),
  type: IssueTypeSchema,
  status: IssueStatusSchema,
  priority: IssuePrioritySchema.optional(),
  labels: z.array(LabelSchema).default([]),
  /** `sourceRef.id` of the milestone the issue belongs to. */
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
   * Raw source payload. NEVER read by business logic — it exists only for
   * reporting and auditing.
   */
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

/** Complete artifact of an extraction: what `export` writes and `analyze`/`apply` consume. */
export const IssueModelSchema = z.object({
  source: z.object({
    platform: z.string().min(1),
    /** Extracted scope, in the platform's format (`owner/repo`). */
    identifier: z.string().min(1),
    extractedAt: z.string(),
  }),
  issues: z.array(IssueSchema),
  milestones: z.array(MilestoneSchema).default([]),
  labels: z.array(LabelSchema).default([]),
});
export type IssueModel = z.infer<typeof IssueModelSchema>;
