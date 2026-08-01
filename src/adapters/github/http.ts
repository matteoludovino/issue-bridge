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
  /** Sobrescreva para GitHub Enterprise Server. */
  baseUrl?: string;
  userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const PER_PAGE = 100;

/**
 * Cliente REST do GitHub: autenticação, paginação por header `Link` e tradução
 * de falha nativa para `MigrationError`.
 */
export class GitHubHttp {
  private readonly baseUrl: string;

  constructor(
    private readonly client: HttpClient,
    private readonly options: GitHubHttpOptions,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // `z.output<S>` (e não um `T` livre) é obrigatório aqui: schemas com
  // `.default()` têm entrada e saída diferentes, e um `z.ZodType<T>` faria o TS
  // inferir o tipo de ENTRADA, deixando campos com default como opcionais.
  async get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
    const response = await this.send(this.resolve(path));
    return this.parse(schema, response.body, path);
  }

  /**
   * Segue `rel="next"` até o fim ou até `limit` itens. `limit` é um teto de
   * segurança: para de paginar assim que atingido.
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

  /** Baixa conteúdo binário autenticado (anexo colado no corpo da issue). */
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

    // Contrato quebrado do GitHub: não é retentável, é bug ou mudança de API.
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
 * Traduz status HTTP + headers de rate limit para a taxonomia do core.
 *
 * O secondary rate limit do GitHub responde 403 com `retry-after`; o primário
 * responde 403/429 com `x-ratelimit-remaining: 0` e `x-ratelimit-reset`.
 * Ambos viram `rate-limit` com espera sugerida.
 */
export function toMigrationError(response: HttpResponse, rawUrl: string): MigrationError {
  // Nunca interpolar a URL crua: a query string pode carregar conteúdo privado.
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
