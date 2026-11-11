import { z } from 'zod';

/**
 * Reference to an entity in the SOURCE system.
 *
 * `id` is the identity key used by the RollbackStore (idempotency) and must be
 * deterministic: extracting the same entity twice yields the same `id`.
 * Recommended convention: `<platform>:<scope>:<kind>:<nativeId>`
 * (e.g. `github:acme/api:issue:123`). `humanRef` is the human-readable label (`#123`).
 */
export const SourceRefSchema = z.object({
  platform: z.string().min(1),
  id: z.string().min(1),
  humanRef: z.string().min(1),
  url: z.string().url(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Person referenced by an issue. `email` and `sourceRef` are optional because
 * most APIs do not expose third-party emails, and system authors (bots,
 * importers) may have no entity of their own in the source.
 */
export const PersonSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email().optional(),
  sourceRef: SourceRefSchema.optional(),
});
export type Person = z.infer<typeof PersonSchema>;

/**
 * Neutral type. The Planner translates it to the actual target name via
 * `MappingConfig.issueTypes` and validates it against `TargetCapabilities.issueTypes`.
 */
export const IssueTypeSchema = z.enum(['epic', 'story', 'task', 'bug', 'subtask']);
export type IssueType = z.infer<typeof IssueTypeSchema>;

/** Neutral state. Translated via `MappingConfig.statuses`. */
export const IssueStatusSchema = z.enum(['open', 'in_progress', 'closed']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

/** Neutral priority. Translated via `MappingConfig.priorities`. */
export const IssuePrioritySchema = z.enum(['highest', 'high', 'medium', 'low', 'lowest']);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

/**
 * Relationship between issues, in neutral vocabulary. The target adapter
 * translates it to its own catalog (issueLinkType, `parent` field, etc.).
 */
export const LinkTypeSchema = z.enum([
  'relates_to',
  'blocks',
  'blocked_by',
  'duplicates',
  'duplicated_by',
  'parent_of',
  'child_of',
]);
export type LinkType = z.infer<typeof LinkTypeSchema>;

/**
 * Link types that define HIERARCHY and therefore creation order.
 * A cycle here is fatal (see `detectCycles` in the Planner); cycles in `blocks`/
 * `blocked_by` are not, because links are only created after all issues.
 */
export const HIERARCHY_LINK_TYPES: readonly LinkType[] = ['parent_of', 'child_of'];

/** Link types that express blocking (no effect on creation order). */
export const BLOCKING_LINK_TYPES: readonly LinkType[] = ['blocks', 'blocked_by'];
