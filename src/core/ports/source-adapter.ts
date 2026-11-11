import type { IssueModel } from '../models/issue-model.js';

export interface ExtractOptions {
  /** Scope to extract, in the platform's format (`owner/repo`). */
  identifier: string;
  includeClosed?: boolean;
  /**
   * Extracts only items changed since this instant (ISO 8601). This is the
   * basis of `sync`: without it, every run re-reads the whole project.
   *
   * The filter is by UPDATE date, so a new comment on an old issue comes along
   * with its parent issue.
   */
  updatedSince?: string;
  /** Extracts only issues that have at least one of these labels. */
  labelFilter?: string[];
  /** Safety cap for exploratory runs. */
  maxItems?: number;
}

/**
 * Read port. A new connector (GitLab, Linear, Notion) implements only
 * this interface — not a single line of `src/core/` changes.
 *
 * Contract:
 *  - Credentials are injected when the adapter is constructed; the core never sees them.
 *  - All native-payload → `IssueModel` translation happens here, validated with Zod.
 *  - Failures are thrown as `MigrationError` (see `src/core/errors.ts`).
 */
export interface SourceAdapter {
  /** Platform identifier (`github`). Appears in `SourceRef.platform`. */
  readonly platformName: string;

  authenticate(): Promise<void>;

  extract(options: ExtractOptions): Promise<IssueModel>;
}
