import { GitHubAttachmentFetcher } from './adapters/github/attachment-fetcher.js';
import {
  DEFAULT_LABEL_CLASSIFICATION,
  type LabelClassification,
} from './adapters/github/classification.js';
import { GitHubSourceAdapter } from './adapters/github/github-source-adapter.js';
import { JiraTargetAdapter } from './adapters/jira/jira-target-adapter.js';
import type { LoadedConfig } from './config/loader.js';
import type { MigrationConfig } from './config/schema.js';
import { Executor, type Logger, type RetryPolicy } from './core/executor/executor.js';
import type { AttachmentFetcher } from './core/ports/attachment-fetcher.js';
import type { ExtractOptions } from './core/ports/source-adapter.js';
import type { MappingConfig } from './core/planner/mapping-config.js';
import { JsonRollbackStore } from './storage/json-rollback-store.js';
import { SyncStateStore } from './storage/sync-state.js';

/**
 * Raiz de composição: o único lugar que conhece config E adapters concretos ao
 * mesmo tempo. A CLI (fase seguinte) só chama estas funções — nenhum comando
 * precisa saber que a origem é GitHub ou que o destino é Jira.
 */

export function createSourceAdapter(loaded: LoadedConfig): GitHubSourceAdapter {
  const { source } = loaded.config;
  return new GitHubSourceAdapter({
    token: loaded.credentials.sourceToken,
    classification: resolveClassification(loaded.config),
    includeRaw: source.includeRaw,
    ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
    ...(source.webBaseUrl === undefined ? {} : { webBaseUrl: source.webBaseUrl }),
  });
}

export function createAttachmentFetcher(loaded: LoadedConfig): AttachmentFetcher {
  const { source } = loaded.config;
  return new GitHubAttachmentFetcher({
    token: loaded.credentials.sourceToken,
    ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
  });
}

export function createTargetAdapter(loaded: LoadedConfig, logger?: Logger): JiraTargetAdapter {
  const { target } = loaded.config;
  return new JiraTargetAdapter({
    baseUrl: target.baseUrl,
    email: loaded.credentials.targetEmail,
    apiToken: loaded.credentials.targetToken,
    epicIssueTypeName: target.epicIssueTypeName,
    ...(target.linkTypeNames === undefined ? {} : { linkTypeNames: target.linkTypeNames }),
    ...(logger === undefined ? {} : { logger }),
  });
}

export function createRollbackStore(loaded: LoadedConfig): Promise<JsonRollbackStore> {
  return JsonRollbackStore.open(loaded.config.execution.ledgerPath);
}

/** Executor completo, com ledger durável e download de anexo pela origem. */
export async function createExecutor(loaded: LoadedConfig, logger: Logger): Promise<Executor> {
  const store = await createRollbackStore(loaded);
  return new Executor(
    createTargetAdapter(loaded, logger),
    store,
    logger,
    createAttachmentFetcher(loaded),
  );
}

/**
 * `config.mappings` já tem exatamente a forma que o Planner consome — este
 * retorno tipado é o que garante, em tempo de compilação, que o schema do YAML
 * e o contrato do core não podem divergir sem quebrar o build.
 */
export function toMappingConfig(config: MigrationConfig): MappingConfig {
  return config.mappings;
}

/**
 * `updatedSince` recebe o maior entre o piso da config e a marca d'água do
 * `sync` — assim um recorte histórico configurado nunca é desfeito por uma marca
 * mais antiga, e a marca nunca é ignorada quando é mais recente.
 */
export function toExtractOptions(
  config: MigrationConfig,
  updatedSince?: string,
): ExtractOptions {
  const { extract, source } = config;
  const since = latestTimestamp(extract.updatedSince, updatedSince);

  return {
    identifier: source.identifier,
    includeClosed: extract.includeClosed,
    ...(since === undefined ? {} : { updatedSince: since }),
    ...(extract.labelFilter.length === 0 ? {} : { labelFilter: extract.labelFilter }),
    ...(extract.maxItems === undefined ? {} : { maxItems: extract.maxItems }),
  };
}

export function toRetryPolicy(config: MigrationConfig): RetryPolicy {
  return config.execution.retry;
}

export function createSyncStateStore(loaded: LoadedConfig): SyncStateStore {
  return new SyncStateStore(loaded.config.execution.syncStatePath);
}

function latestTimestamp(...candidates: (string | undefined)[]): string | undefined {
  const valid = candidates.filter((value): value is string => value !== undefined);
  if (valid.length === 0) return undefined;
  return valid.reduce((latest, current) =>
    Date.parse(current) > Date.parse(latest) ? current : latest,
  );
}

function resolveClassification(config: MigrationConfig): LabelClassification {
  const overrides = config.source.classification;
  return {
    typeByLabel: { ...DEFAULT_LABEL_CLASSIFICATION.typeByLabel, ...overrides?.typeByLabel },
    priorityByLabel: {
      ...DEFAULT_LABEL_CLASSIFICATION.priorityByLabel,
      ...overrides?.priorityByLabel,
    },
    inProgressLabels: overrides?.inProgressLabels ?? DEFAULT_LABEL_CLASSIFICATION.inProgressLabels,
    defaultType: overrides?.defaultType ?? DEFAULT_LABEL_CLASSIFICATION.defaultType,
  };
}
