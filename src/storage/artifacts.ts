import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { MigrationError } from '../core/errors.js';
import type { ExecutionResult } from '../core/executor/executor.js';
import { IssueModelSchema, type IssueModel } from '../core/models/issue-model.js';
import {
  MigrationPlanSchema,
  PlanActionSchema,
  type MigrationPlan,
} from '../core/models/migration-plan.js';

/**
 * Reading and writing of the migration artifacts, always validated with Zod.
 *
 * A snapshot or plan written by an older version must not be consumed
 * blindly: it would mean wrong writes to the target. Every read goes through the schema.
 */

const TargetItemRefSchema = z.object({
  id: z.string(),
  humanRef: z.string(),
  url: z.string().optional(),
});

/**
 * The annotation is what guarantees, at compile time, that this schema cannot
 * diverge from the core interface. The input type is `unknown` because schemas
 * with `.default()` have an input type that differs from the output type — pinning
 * input and output to the same type would reject `PlanActionSchema` itself.
 */
export const ExecutionResultSchema: z.ZodType<ExecutionResult, unknown> = z.object({
  succeeded: z.array(
    z.object({
      action: PlanActionSchema,
      targetRef: TargetItemRefSchema.nullable(),
      attempts: z.number().int().nonnegative(),
    }),
  ),
  skipped: z.array(
    z.object({
      action: PlanActionSchema,
      reason: z.literal('skipped_already_migrated'),
      targetRef: TargetItemRefSchema,
    }),
  ),
  failed: z.array(
    z.object({
      action: PlanActionSchema,
      error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      }),
      attempts: z.number().int().nonnegative(),
    }),
  ),
  startedAt: z.string(),
  finishedAt: z.string(),
  dryRun: z.boolean(),
});

/** Fixed artifact names inside the working directory. */
export const ARTIFACT_FILES = {
  snapshot: 'snapshot.json',
  plan: 'plan.json',
  execution: 'execution.json',
  report: 'migration-report.md',
} as const;

export function artifactPath(directory: string, kind: keyof typeof ARTIFACT_FILES): string {
  return join(directory, ARTIFACT_FILES[kind]);
}

export async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

export const readSnapshot = (filePath: string): Promise<IssueModel> =>
  readValidated(filePath, IssueModelSchema, 'snapshot');

export const readPlan = (filePath: string): Promise<MigrationPlan> =>
  readValidated(filePath, MigrationPlanSchema, 'plan');

export const readExecution = (filePath: string): Promise<ExecutionResult> =>
  readValidated(filePath, ExecutionResultSchema, 'execution log');

async function readValidated<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
  label: string,
): Promise<z.output<S>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause: unknown) {
    throw new MigrationError({
      code: 'not-found',
      message: `Could not find the ${label} at ${filePath}.`,
      cause,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (cause: unknown) {
    throw new MigrationError({
      code: 'validation',
      message: `The ${label} at ${filePath} is not valid JSON.`,
      cause,
    });
  }

  const result = schema.safeParse(payload);
  if (result.success) return result.data;

  throw new MigrationError({
    code: 'validation',
    message: `The ${label} at ${filePath} does not match the expected format (most likely written by another version): ${
      result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')
    }`,
    cause: result.error,
  });
}
