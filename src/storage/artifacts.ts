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
 * Leitura e escrita dos artefatos da migração, sempre validados por Zod.
 *
 * Um snapshot ou plano gravado por uma versão antiga não pode ser consumido às
 * cegas: seria escrita errada no destino. Toda leitura passa pelo schema.
 */

const TargetItemRefSchema = z.object({
  id: z.string(),
  humanRef: z.string(),
  url: z.string().optional(),
});

/**
 * A anotação é o que garante, em tempo de compilação, que este schema não pode
 * divergir da interface do core. O terceiro parâmetro é `unknown` porque schemas
 * com `.default()` têm tipo de entrada diferente do de saída — travar entrada e
 * saída no mesmo tipo rejeitaria o próprio `PlanActionSchema`.
 */
export const ExecutionResultSchema: z.ZodType<ExecutionResult, z.ZodTypeDef, unknown> = z.object({
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

/** Nomes fixos dos artefatos dentro do diretório de trabalho. */
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
  readValidated(filePath, MigrationPlanSchema, 'plano');

export const readExecution = (filePath: string): Promise<ExecutionResult> =>
  readValidated(filePath, ExecutionResultSchema, 'log de execução');

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
      message: `Não encontrei o ${label} em ${filePath}.`,
      cause,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (cause: unknown) {
    throw new MigrationError({
      code: 'validation',
      message: `O ${label} em ${filePath} não é JSON válido.`,
      cause,
    });
  }

  const result = schema.safeParse(payload);
  if (result.success) return result.data;

  throw new MigrationError({
    code: 'validation',
    message: `O ${label} em ${filePath} está fora do formato esperado (provavelmente gerado por outra versão): ${
      result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')
    }`,
    cause: result.error,
  });
}
