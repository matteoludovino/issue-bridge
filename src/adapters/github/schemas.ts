import { z } from 'zod';

/**
 * Schemas for the GitHub REST payloads the adapter consumes.
 *
 * Only the fields in use are declared — Zod strips the rest. Fields the API
 * returns as `null` use `.nullish()` to tolerate both absence and null.
 */

export const GitHubUserSchema = z.object({
  login: z.string(),
  id: z.number(),
  html_url: z.string().url(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  type: z.string().nullish(),
});
export type GitHubUser = z.infer<typeof GitHubUserSchema>;

export const GitHubLabelSchema = z.object({
  name: z.string(),
  color: z.string().nullish(),
  description: z.string().nullish(),
});
export type GitHubLabel = z.infer<typeof GitHubLabelSchema>;

export const GitHubMilestoneSchema = z.object({
  number: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  due_on: z.string().nullish(),
  closed_at: z.string().nullish(),
  html_url: z.string().url(),
});
export type GitHubMilestone = z.infer<typeof GitHubMilestoneSchema>;

export const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullish(),
  labels: z.array(GitHubLabelSchema).default([]),
  user: GitHubUserSchema.nullish(),
  assignees: z.array(GitHubUserSchema).default([]),
  milestone: GitHubMilestoneSchema.nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  html_url: z.string().url(),
  comments: z.number().default(0),
  /** Present only when the item is actually a pull request. */
  pull_request: z.unknown().optional(),
});
export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;

export const GitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  user: GitHubUserSchema.nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  html_url: z.string().url(),
});
export type GitHubComment = z.infer<typeof GitHubCommentSchema>;

/** `GET /user` — used only to validate the credentials. */
export const GitHubViewerSchema = z.object({
  login: z.string(),
  id: z.number(),
});
