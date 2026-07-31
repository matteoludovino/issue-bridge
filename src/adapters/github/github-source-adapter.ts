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
  /** Personal access token ou token de app. Injetado pela camada de config. */
  token: string;
  /** Base da API. Troque para GitHub Enterprise Server. */
  baseUrl?: string;
  /** Base web, usada para montar URL de issue referenciada mas não extraída. */
  webBaseUrl?: string;
  /** Injete nos testes; em produção usa o `fetch` global. */
  httpClient?: HttpClient;
  /** Como labels do GitHub viram tipo/prioridade/status neutros. */
  classification?: LabelClassification;
  /** Guarda o payload original em `Issue.raw`. Dobra o tamanho do snapshot. */
  includeRaw?: boolean;
  /** Injete nos testes para `extractedAt` determinístico. */
  clock?: Clock;
  userAgent?: string;
}

const DEFAULT_WEB_BASE_URL = 'https://github.com';

/**
 * Implementa `SourceAdapter` sobre a REST API do GitHub, sem SDK — só `fetch`
 * atrás da interface `HttpClient`.
 *
 * Limitações conhecidas (documentadas em vez de silenciosas):
 *  - Anexos só existem como URL no markdown; não há endpoint de anexos em issues.
 *  - Hierarquia vem de task list (`- [ ] #12`), única fonte disponível sem a API
 *    de sub-issues.
 *  - Pull requests são descartados: a API de issues os devolve misturados.
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

    const rawItems = await this.http.paginate(
      `/repos/${scope}/issues?${query.toString()}`,
      GitHubIssueSchema,
      options.maxItems,
    );

    // `maxItems` limita ITENS LIDOS da API; como PRs vêm misturados e são
    // descartados, o resultado pode ter menos issues que o teto pedido.
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

    // Validação da fronteira de SAÍDA: o core só recebe modelo válido.
    return IssueModelSchema.parse({
      source: { platform: this.platformName, identifier: scope, extractedAt: this.clock.now() },
      issues: applyHierarchy(issues),
      milestones: milestones.map((milestone) => toMilestone(context, milestone)),
      labels: labels.map(toLabel),
    });
  }
}

/** `owner/repo` → validado antes de virar path de API. */
function parseIdentifier(identifier: string): string {
  const parts = identifier.split('/').filter((part) => part.length > 0);
  const [owner, repo] = parts;
  if (parts.length !== 2 || owner === undefined || repo === undefined) {
    throw new MigrationError({
      code: 'validation',
      message: `Identificador inválido "${identifier}": use o formato "owner/repo".`,
    });
  }
  return `${owner}/${repo}`;
}
