export { GitHubAttachmentFetcher } from './attachment-fetcher.js';
export {
  DEFAULT_LABEL_CLASSIFICATION,
  classifyPriority,
  classifyStatus,
  classifyType,
  type LabelClassification,
} from './classification.js';
export {
  GitHubSourceAdapter,
  type GitHubSourceAdapterOptions,
} from './github-source-adapter.js';
export { GitHubHttp, toMigrationError, type GitHubHttpOptions } from './http.js';
