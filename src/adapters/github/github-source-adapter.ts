import { MigrationError } from '../../core/errors.js';
import type { Issue, IssueModel } from '../../core/models/issue-model.js';
import { IssueModelSchema } from '../../core/models/issue-model.js';
import type { Clock } from '../../core/ports/clock.js';
import type { ExtractOptions, SourceAdapter } from '../../core/ports/source-adapter.js';
import { FetchHttpClient, type HttpClient } from '../http.js';
import { DEFAULT_LABEL_CLASSIFICATION, type LabelClassification } from './classification.js';
import { GitHubHttp } from './http.js';
import { applyHierarchy, toIssue, toLabel, toMilestone, type MapperContext } from './mapper.js';
import {
  GitHubCommentSchema,
  GitHubIssueSchema,
  GitHubLabelSchema,
  GitHubMilestoneSchema,
  GitHubViewerSchema,
} from './schemas.js';

export interface GitHubSourceAdapterOptions {
  /** Personal access token or app token. Injected by the config layer. */
  token: string;
  /** API base URL. Change it for GitHub Enterprise Server. */
  baseUrl?: string;
  /** Web base URL, used to build links to issues that are referenced but not extracted. */
  webBaseUrl?: string;
  /** Inject in tests; production uses the global `fetch`. */
  httpClient?: HttpClient;
  /** How GitHub labels become neutral type/priority/status. */
  classification?: LabelClassification;
  /** Keeps the original payload in `Issue.raw`. Doubles the snapshot size. */
  includeRaw?: boolean;
  /** Inject in tests for a deterministic `extractedAt`. */
  clock?: Clock;
  userAgent?: string;
}

const DEFAULT_WEB_BASE_URL = 'https://github.com';

/**
 * Implements `SourceAdapter` on top of the GitHub REST API, without an SDK — just `fetch`
 * behind the `HttpClient` interface.
 *
 * Known limitations (documented rather than silent):
 *  - Attachments only exist as URLs in the markdown; issues have no attachments endpoint.
 *  - Hierarchy comes from task lists (`- [ ] #12`), the only source available without the
 *    sub-issues API.
 *  - Pull requests are discarded: the issues API returns them mixed in.
 */
export class GitHubSourceAdapter implements SourceAdapter {
  readonly platformName = 'github';

  private readonly http: GitHubHttp;
  private readonly context: Omit<MapperContext, 'scope'>;
  private readonly clock: Clock;

  constructor(options: GitHubSourceAdapterOptions) {
    this.http = new GitHubHttp(options.httpClient ?? new FetchHttpClient(), {
      token: options.token,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    });
    this.context = {
      webBaseUrl: options.webBaseUrl ?? DEFAULT_WEB_BASE_URL,
      classification: options.classification ?? DEFAULT_LABEL_CLASSIFICATION,
      includeRaw: options.includeRaw ?? false,
    };
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }

  async authenticate(): Promise<void> {
    await this.http.get('/user', GitHubViewerSchema);
  }

  async extract(options: ExtractOptions): Promise<IssueModel> {
    const scope = parseIdentifier(options.identifier);
    const context: MapperContext = { ...this.context, scope };

    const query = new URLSearchParams({
      state: options.includeClosed === false ? 'open' : 'all',
      sort: 'created',
      direction: 'asc',
    });
    if (options.labelFilter !== undefined && options.labelFilter.length > 0) {
      query.set('labels', options.labelFilter.join(','));
    }
    // GitHub's `since` filters on `updated_at`, which is exactly the semantics of
    // `updatedSince`: a changed issue comes back in full, with its new comments.
    if (options.updatedSince !== undefined) {
      query.set('since', options.updatedSince);
    }

    const rawItems = await this.http.paginate(
      `/repos/${scope}/issues?${query.toString()}`,
      GitHubIssueSchema,
      options.maxItems,
    );

    // `maxItems` caps the ITEMS READ from the API; since PRs come mixed in and are
    // discarded, the result may contain fewer issues than the requested cap.
    const rawIssues = rawItems
      .filter((item) => item.pull_request === undefined)
      .slice(0, options.maxItems ?? rawItems.length);

    const issues: Issue[] = [];
    for (const raw of rawIssues) {
      const comments =
        raw.comments > 0
          ? await this.http.paginate(
              `/repos/${scope}/issues/${String(raw.number)}/comments`,
              GitHubCommentSchema,
            )
          : [];
      issues.push(toIssue({ context, issue: raw, comments }));
    }

    const [labels, milestones] = await Promise.all([
      this.http.paginate(`/repos/${scope}/labels`, GitHubLabelSchema),
      this.http.paginate(`/repos/${scope}/milestones?state=all`, GitHubMilestoneSchema),
    ]);

    // OUTPUT boundary validation: the core only ever receives a valid model.
    return IssueModelSchema.parse({
      source: { platform: this.platformName, identifier: scope, extractedAt: this.clock.now() },
      issues: applyHierarchy(issues),
      milestones: milestones.map((milestone) => toMilestone(context, milestone)),
      labels: labels.map(toLabel),
    });
  }
}

/** `owner/repo` → validated before it becomes an API path. */
function parseIdentifier(identifier: string): string {
  const parts = identifier.split('/').filter((part) => part.length > 0);
  const [owner, repo] = parts;
  if (parts.length !== 2 || owner === undefined || repo === undefined) {
    throw new MigrationError({
      code: 'validation',
      message: `Invalid identifier "${identifier}": use the "owner/repo" format.`,
    });
  }
  return `${owner}/${repo}`;
}
