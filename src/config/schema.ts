import { z } from 'zod';
import { IssuePrioritySchema, IssueTypeSchema } from '../core/models/common.js';

/**
 * Schema do arquivo de configuração YAML.
 *
 * Duas decisões que valem explicação:
 *  - **`.strict()` em tudo**: chave desconhecida é ERRO, não é ignorada. Num
 *    arquivo de config escrito à mão, `milestoneStategy` silenciosamente
 *    ignorado é pior que uma mensagem de erro.
 *  - **credencial nunca no arquivo**: só o NOME da variável de ambiente, para o
 *    YAML poder ser versionado.
 */

const RetryConfigSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(5),
    baseDelayMs: z.number().int().positive().default(500),
    maxDelayMs: z.number().int().positive().default(30_000),
  })
  .strict()
  .default({});

const ClassificationConfigSchema = z
  .object({
    /** label (minúscula) → tipo neutro. Mesclado sobre o padrão do adapter. */
    typeByLabel: z.record(IssueTypeSchema).optional(),
    priorityByLabel: z.record(IssuePrioritySchema).optional(),
    /** Substitui a lista padrão (não mescla): é a lista completa. */
    inProgressLabels: z.array(z.string()).optional(),
    defaultType: IssueTypeSchema.optional(),
  })
  .strict();

const SourceConfigSchema = z
  .object({
    /** Só `github` está implementado; qualquer outro valor falha na config. */
    platform: z.literal('github'),
    identifier: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'use o formato "owner/repo"'),
    tokenEnv: z.string().min(1).default('GITHUB_TOKEN'),
    /** Base da API, para GitHub Enterprise Server. */
    baseUrl: z.string().url().optional(),
    webBaseUrl: z.string().url().optional(),
    /** Guarda o payload bruto em `Issue.raw`; dobra o tamanho do snapshot. */
    includeRaw: z.boolean().default(false),
    classification: ClassificationConfigSchema.optional(),
  })
  .strict();

const TargetConfigSchema = z
  .object({
    platform: z.literal('jira'),
    baseUrl: z.string().url(),
    projectKey: z.string().min(1),
    emailEnv: z.string().min(1).default('JIRA_EMAIL'),
    tokenEnv: z.string().min(1).default('JIRA_API_TOKEN'),
    epicIssueTypeName: z.string().min(1).default('Epic'),
    /** Tipo canônico de link → nome no destino. */
    linkTypeNames: z.record(z.string()).optional(),
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
      .default({}),
    priorities: z
      .object({
        highest: z.string().min(1).default('Highest'),
        high: z.string().min(1).default('High'),
        medium: z.string().min(1).default('Medium'),
        low: z.string().min(1).default('Low'),
        lowest: z.string().min(1).default('Lowest'),
      })
      .strict()
      .default({}),
    statuses: z
      .object({
        open: z.string().min(1).default('To Do'),
        in_progress: z.string().min(1).default('In Progress'),
        closed: z.string().min(1).default('Done'),
      })
      .strict()
      .default({}),
    milestoneStrategy: z.enum(['epic', 'version']).default('epic'),
    defaultPriority: IssuePrioritySchema.optional(),
    /**
     * Valores de campo do destino, por id (`customfield_10042`). É o canal que
     * satisfaz custom field obrigatório — sem ele, o `analyze` bloqueia.
     */
    fields: z
      .object({
        defaults: z.record(z.unknown()).default({}),
        /** Indexado pelo NOME do tipo no destino; vence `defaults`. */
        byIssueType: z.record(z.record(z.unknown())).default({}),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

const ExtractConfigSchema = z
  .object({
    includeClosed: z.boolean().default(true),
    labelFilter: z.array(z.string()).default([]),
    /** Teto de itens lidos da API (issues + PRs, que são descartados). */
    maxItems: z.number().int().positive().optional(),
    /**
     * Piso fixo de data de alteração (ISO 8601). Serve para recortar um
     * histórico longo; o `sync` usa a própria marca d'água quando ela é mais
     * recente que este valor.
     */
    updatedSince: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .default({});

const ExecutionConfigSchema = z
  .object({
    /** Onde fica o ledger origem → destino. */
    ledgerPath: z.string().min(1).default('.issue-bridge/ledger.json'),
    /** Marca d'água do `sync`: até quando a origem já foi lida. */
    syncStatePath: z.string().min(1).default('.issue-bridge/sync-state.json'),
    retry: RetryConfigSchema,
    /**
     * Ações independentes escritas em paralelo. Acima de ~8 o rate limit do
     * destino costuma virar o gargalo — o retry absorve, mas fica mais lento.
     * Use 1 para depurar com ordem determinística.
     */
    concurrency: z.number().int().min(1).max(16).default(4),
  })
  .strict()
  .default({});

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
