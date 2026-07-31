import { MigrationError } from '../core/errors.js';

/**
 * Contrato HTTP compartilhado pelos adapters.
 *
 * Fica fora de `github/` e `jira/` porque os dois usam o mesmo cliente. Existe
 * para que os adapters sejam testáveis sem rede e sem depender de tipos DOM
 * (`Response`, `Headers`) — o `tsconfig` só carrega `lib: ES2022`.
 */
export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string | Uint8Array;
  /** `binary` preenche `HttpResponse.bytes` em vez de `body`. */
  responseType?: 'text' | 'binary';
}

export interface HttpResponse {
  status: number;
  /** Nomes de header em minúsculas. */
  headers: Record<string, string>;
  /** Corpo como texto. Vazio quando a resposta foi pedida como binária. */
  body: string;
  /** Bytes crus, presentes quando `request.responseType === 'binary'`. */
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

/** Cliente padrão sobre o `fetch` global do Node ≥ 18. Sem dependências. */
export class FetchHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    if (typeof globalFetch !== 'function') {
      throw new MigrationError({
        code: 'unknown',
        message: 'fetch global indisponível: use Node 18+ ou injete um HttpClient.',
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
      // Falha de socket/DNS é transitória por definição — o Executor decide o retry.
      throw new MigrationError({
        code: 'transient',
        message: `Falha de rede em ${request.url}: ${
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

/** `<https://…&page=2>; rel="next"` → URL de `next`. Usado na paginação por Link. */
export function nextPageUrl(linkHeader: string | undefined): string | undefined {
  if (linkHeader === undefined) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Trecho do corpo de erro, para mensagens acionáveis sem despejar payload inteiro. */
export function summarizeBody(body: string, limit = 300): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** `retry-after` (segundos) ou janela de reset do rate limit, em ms. */
export function retryDelayMs(headers: Record<string, string>): number | undefined {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  }

  if (headers['x-ratelimit-remaining'] !== '0') return undefined;
  const reset = Number(headers['x-ratelimit-reset']);
  if (!Number.isFinite(reset)) return undefined;
  // `reset` é epoch em segundos.
  return Math.max(0, reset * 1000 - Date.now());
}
