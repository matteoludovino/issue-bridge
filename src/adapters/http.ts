import { MigrationError } from '../core/errors.js';

/**
 * HTTP contract shared by the adapters.
 *
 * Lives outside `github/` and `jira/` because both use the same client. It exists
 * so the adapters can be tested without a network and without depending on DOM types
 * (`Response`, `Headers`) — the `tsconfig` only loads `lib: ES2022`.
 */
export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string | Uint8Array;
  /** `binary` fills `HttpResponse.bytes` instead of `body`. */
  responseType?: 'text' | 'binary';
}

export interface HttpResponse {
  status: number;
  /** Header names in lowercase. */
  headers: Record<string, string>;
  /** Body as text. Empty when the response was requested as binary. */
  body: string;
  /** Raw bytes, present when `request.responseType === 'binary'`. */
  bytes?: Uint8Array;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

interface FetchLikeResponse {
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
) => Promise<FetchLikeResponse>;

/** Default client on top of the global `fetch` in Node ≥ 18. No dependencies. */
export class FetchHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    if (typeof globalFetch !== 'function') {
      throw new MigrationError({
        code: 'unknown',
        message: 'Global fetch is unavailable: use Node 18+ or inject an HttpClient.',
      });
    }

    let response: FetchLikeResponse;
    try {
      response = await (globalFetch as FetchLike)(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (cause: unknown) {
      // A socket/DNS failure is transient by definition — the Executor decides on retries.
      throw new MigrationError({
        code: 'transient',
        message: `Network failure for ${redactUrl(request.url)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      });
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (request.responseType === 'binary') {
      return {
        status: response.status,
        headers,
        body: '',
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    }

    return { status: response.status, headers, body: await response.text() };
  }
}

/** `<https://…&page=2>; rel="next"` → the `next` URL. Used for Link-header pagination. */
export function nextPageUrl(linkHeader: string | undefined): string | undefined {
  if (linkHeader === undefined) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/**
 * Strips the query string from a URL before it ends up in an error message, log
 * or report.
 *
 * This is not paranoia: Jira search carries the JQL in the query (`?jql=project = "ENG" AND
 * summary ~ "..."`), so a network failure during reconciliation would dump a private
 * issue title into the log. The path is enough for diagnosis.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const suffix = parsed.search.length > 0 ? '?[redacted]' : '';
    return `${parsed.origin}${parsed.pathname}${suffix}`;
  } catch {
    // Malformed URL: return everything before the query, by brute force.
    return url.split('?')[0] ?? url;
  }
}

/** Excerpt of an error body, for actionable messages without dumping the whole payload. */
export function summarizeBody(body: string, limit = 300): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** `retry-after` (seconds) or the rate-limit reset window, in ms. */
export function retryDelayMs(headers: Record<string, string>): number | undefined {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  }

  if (headers['x-ratelimit-remaining'] !== '0') return undefined;
  const reset = Number(headers['x-ratelimit-reset']);
  if (!Number.isFinite(reset)) return undefined;
  // `reset` is a Unix epoch in seconds.
  return Math.max(0, reset * 1000 - Date.now());
}
