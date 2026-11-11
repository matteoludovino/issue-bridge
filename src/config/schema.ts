import { z } from 'zod';
import { IssuePrioritySchema, IssueTypeSchema } from '../core/models/common.js';

/**
 * Schema of the YAML configuration file.
 *
 * Two decisions worth explaining:
 *  - **`.strict()` everywhere**: an unknown key is an ERROR, not ignored. In a
 *    hand-written config file, a silently ignored `milestoneStategy` is worse
 *    than an error message.
 *  - **credentials never in the file**: only the NAME of the environment
 *    variable, so the YAML can be kept under version control.
 */

const RetryConfigSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(5),
    baseDelayMs: z.number().int().positive().default(500),
    maxDelayMs: z.number().int().positive().default(30_000),
  })
  .strict()
  .prefault({});

const ClassificationConfigSchema = z
  .object({
    /** label (lowercase) → neutral type. Merged over the adapter's default. */
    typeByLabel: z.record(z.string(), IssueTypeSchema).optional(),
    priorityByLabel: z.record(z.string(), IssuePrioritySchema).optional(),
    /** Replaces the default list (no merging): this is the complete list. */
    inProgressLabels: z.array(z.string()).optional(),
    defaultType: IssueTypeSchema.optional(),
  })
  .strict();

const SourceConfigSchema = z
  .object({
    /** Only `github` is implemented; any other value fails config validation. */
    platform: z.literal('github'),
    identifier: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'use the "owner/repo" format'),
    tokenEnv: z.string().min(1).default('GITHUB_TOKEN'),
    /** API base URL, for GitHub Enterprise Server. */
    baseUrl: z.url().optional(),
    webBaseUrl: z.url().optional(),
    /** Keeps the raw payload in `Issue.raw`; doubles the snapshot size. */
    includeRaw: z.boolean().default(false),
    classification: ClassificationConfigSchema.optional(),
  })
  .strict();

const TargetConfigSchema = z
  .object({
    platform: z.literal('jira'),
    baseUrl: z.url(),
    projectKey: z.string().min(1),
    emailEnv: z.string().min(1).default('JIRA_EMAIL'),
    tokenEnv: z.string().min(1).default('JIRA_API_TOKEN'),
    epicIssueTypeName: z.string().min(1).default('Epic'),
    /** Canonical link type → name in the target. */
    linkTypeNames: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const MappingsConfigSchema = z
  .object({
    issueTypes: z
      .object({
        epic: z.string().min(1).default('Epic'),
        story: z.string().min(1).default('Story'),
        task: z.string().min(1).default('Task'),
        bug: z.string().min(1).default('Bug'),
        subtask: z.string().min(1).default('Sub-task'),
      })
      .strict()
      .prefault({}),
    priorities: z
      .object({
        highest: z.string().min(1).default('Highest'),
        high: z.string().min(1).default('High'),
        medium: z.string().min(1).default('Medium'),
        low: z.string().min(1).default('Low'),
        lowest: z.string().min(1).default('Lowest'),
      })
      .strict()
      .prefault({}),
    statuses: z
      .object({
        open: z.string().min(1).default('To Do'),
        in_progress: z.string().min(1).default('In Progress'),
        closed: z.string().min(1).default('Done'),
      })
      .strict()
      .prefault({}),
    milestoneStrategy: z.enum(['epic', 'version']).default('epic'),
    defaultPriority: IssuePrioritySchema.optional(),
    /**
     * Target field values, by id (`customfield_10042`). This is how required
     * custom fields get satisfied — without it, `analyze` blocks.
     */
    fields: z
      .object({
        defaults: z.record(z.string(), z.unknown()).default({}),
        /** Keyed by the issue type NAME in the target; takes precedence over `defaults`. */
        byIssueType: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

const ExtractConfigSchema = z
  .object({
    includeClosed: z.boolean().default(true),
    labelFilter: z.array(z.string()).default([]),
    /** Cap on items read from the API (issues + PRs, which are discarded). */
    maxItems: z.number().int().positive().optional(),
    /**
     * Fixed floor on the last-updated date (ISO 8601). Useful for trimming a
     * long history; `sync` uses its own watermark when that is more
     * recent than this value.
     */
    updatedSince: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .prefault({});

const ExecutionConfigSchema = z
  .object({
    /** Where the source → target ledger is stored. */
    ledgerPath: z.string().min(1).default('.issue-bridge/ledger.json'),
    /** `sync` watermark: up to when the source has already been read. */
    syncStatePath: z.string().min(1).default('.issue-bridge/sync-state.json'),
    retry: RetryConfigSchema,
    /**
     * Independent actions written in parallel. Above ~8, the target's rate
     * limit tends to become the bottleneck — retries absorb it, but it is slower.
     * Use 1 to debug with a deterministic order.
     */
    concurrency: z.number().int().min(1).max(16).default(4),
  })
  .strict()
  .prefault({});

export const MigrationConfigSchema = z
  .object({
    version: z.literal(1),
    source: SourceConfigSchema,
    target: TargetConfigSchema,
    mappings: MappingsConfigSchema,
    extract: ExtractConfigSchema,
    execution: ExecutionConfigSchema,
  })
  .strict();

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type MappingsConfig = z.infer<typeof MappingsConfigSchema>;
export type ExtractConfig = z.infer<typeof ExtractConfigSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
