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
 * Composition root: the only place that knows both the config AND the concrete
 * adapters. The CLI (next phase) only calls these functions — no command
 * needs to know that the source is GitHub or that the target is Jira.
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

/** Full executor, with a durable ledger and attachment download through the source. */
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
 * `config.mappings` already has exactly the shape the Planner consumes — this
 * typed return is what guarantees, at compile time, that the YAML schema and
 * the core contract cannot diverge without breaking the build.
 */
export function toMappingConfig(config: MigrationConfig): MappingConfig {
  return config.mappings;
}

/**
 * `updatedSince` gets the later of the config floor and the `sync` watermark —
 * so a configured historical cutoff is never undone by an older watermark, and
 * the watermark is never ignored when it is more recent.
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
