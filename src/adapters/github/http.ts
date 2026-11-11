import type { z } from 'zod';
import { MigrationError } from '../../core/errors.js';
import {
  nextPageUrl,
  redactUrl,
  retryDelayMs,
  summarizeBody,
  type HttpClient,
  type HttpResponse,
} from '../http.js';

export interface GitHubHttpOptions {
  token: string;
  /** Override for GitHub Enterprise Server. */
  baseUrl?: string;
  userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const PER_PAGE = 100;

/**
 * GitHub REST client: authentication, `Link`-header pagination and translation
 * of native failures into `MigrationError`.
 */
export class GitHubHttp {
  private readonly baseUrl: string;

  constructor(
    private readonly client: HttpClient,
    private readonly options: GitHubHttpOptions,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // `z.output<S>` (rather than a free `T`) is required here: schemas with
  // `.default()` have different input and output types, and a `z.ZodType<T>` would make TS
  // infer the INPUT type, leaving defaulted fields optional.
  async get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
    const response = await this.send(this.resolve(path));
    return this.parse(schema, response.body, path);
  }

  /**
   * Follows `rel="next"` to the end or up to `limit` items. `limit` is a safety
   * cap: pagination stops as soon as it is reached.
   */
  async paginate<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    limit?: number,
  ): Promise<z.output<S>[]> {
    const collected: z.output<S>[] = [];
    let url: string | undefined = this.resolve(path, { per_page: String(PER_PAGE) });

    while (url !== undefined) {
      const response = await this.send(url);
      const page = this.parse(schema.array(), response.body, path);
      collected.push(...page);

      if (limit !== undefined && collected.length >= limit) return collected.slice(0, limit);
      if (page.length === 0) break;
      url = nextPageUrl(response.headers['link']);
    }

    return collected;
  }

  /** Downloads authenticated binary content (an attachment pasted into the issue body). */
  async getBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
    const response = await this.send(url, 'binary');
    return {
      bytes: response.bytes ?? new Uint8Array(),
      contentType: response.headers['content-type'],
    };
  }

  private resolve(path: string, extraQuery: Record<string, string> = {}): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(extraQuery)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async send(url: string, responseType: 'text' | 'binary' = 'text'): Promise<HttpResponse> {
    const response = await this.client.send({
      url,
      method: 'GET',
      responseType,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': this.options.userAgent ?? 'issue-bridge',
      },
    });

    if (response.status >= 200 && response.status < 300) return response;
    throw toMigrationError(response, url);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, body: string, path: string): z.output<S> {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause: unknown) {
      throw new MigrationError({
        code: 'unknown',
        message: `Non-JSON response from ${path}.`,
        cause,
      });
    }

    const result = schema.safeParse(payload);
    if (result.success) return result.data;

    // GitHub broke the contract: not retryable, it is a bug or an API change.
    throw new MigrationError({
      code: 'validation',
      message: `Response from ${path} does not match the expected schema: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
      cause: result.error,
    });
  }
}

/**
 * Maps HTTP status + rate-limit headers to the core error taxonomy.
 *
 * GitHub's secondary rate limit responds 403 with `retry-after`; the primary one
 * responds 403/429 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset`.
 * Both become `rate-limit` with a suggested wait.
 */
export function toMigrationError(response: HttpResponse, rawUrl: string): MigrationError {
  // Never interpolate the raw URL: the query string may carry private content.
  const url = redactUrl(rawUrl);
  const retryAfterMs = retryDelayMs(response.headers);
  const detail = summarizeBody(response.body, 200);

  if (response.status === 401) {
    return new MigrationError({
      code: 'auth',
      message: `GitHub credentials are invalid or expired (401 from ${url}).`,
    });
  }

  if (response.status === 429 || (response.status === 403 && retryAfterMs !== undefined)) {
    return new MigrationError({
      code: 'rate-limit',
      message: `GitHub rate limit hit at ${url}. ${detail}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  if (response.status === 403) {
    return new MigrationError({
      code: 'forbidden',
      message: `No permission for ${url}. ${detail}`,
    });
  }

  if (response.status === 404) {
    return new MigrationError({ code: 'not-found', message: `Resource not found: ${url}.` });
  }

  if (response.status === 422) {
    return new MigrationError({
      code: 'validation',
      message: `GitHub rejected the request at ${url}. ${detail}`,
    });
  }

  if (response.status >= 500) {
    return new MigrationError({
      code: 'transient',
      message: `GitHub is unavailable (${String(response.status)}) at ${url}.`,
    });
  }

  return new MigrationError({
    code: 'unknown',
    message: `Unexpected response ${String(response.status)} from ${url}. ${detail}`,
  });
}
