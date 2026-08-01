import { Buffer } from 'node:buffer';
import type { z } from 'zod';
import { MigrationError } from '../../core/errors.js';
import {
  redactUrl,
  retryDelayMs,
  summarizeBody,
  type HttpClient,
  type HttpResponse,
} from '../http.js';

export interface JiraHttpOptions {
  /** Ex.: `https://acme.atlassian.net`. */
  baseUrl: string;
  /** E-mail da conta Atlassian dona do API token. */
  email: string;
  apiToken: string;
  userAgent?: string;
}

export interface FileUpload {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Cliente REST v3 do Jira Cloud: Basic auth, multipart de anexo e tradução de
 * falha nativa para `MigrationError`.
 */
export class JiraHttp {
  private readonly baseUrl: string;
  private boundaryCounter = 0;

  constructor(
    private readonly client: HttpClient,
    private readonly options: JiraHttpOptions,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
    const response = await this.send({ url: this.resolve(path), method: 'GET' });
    return this.parse(schema, response.body, path);
  }

  async post<S extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    const response = await this.send({
      url: this.resolve(path),
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    return this.parse(schema, response.body, path);
  }

  /** Para endpoints que respondem 201/204 sem corpo (ex.: `POST /issueLink`). */
  async postVoid(path: string, body: unknown): Promise<void> {
    await this.send({
      url: this.resolve(path),
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Upload de anexo: `multipart/form-data` montado à mão (sem dependência de
   * FormData/undici) e o header `X-Atlassian-Token: no-check`, exigido pelo Jira
   * para proteção XSRF.
   */
  async postFile<S extends z.ZodTypeAny>(
    path: string,
    file: FileUpload,
    schema: S,
  ): Promise<z.output<S>> {
    this.boundaryCounter += 1;
    const boundary = `issue-bridge-${String(this.boundaryCounter)}`;
    const response = await this.send({
      url: this.resolve(path),
      method: 'POST',
      body: multipartBody(boundary, file),
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-atlassian-token': 'no-check',
      },
    });
    return this.parse(schema, response.body, path);
  }

  private resolve(path: string): string {
    return path.startsWith('http') ? path : `${this.baseUrl}${path}`;
  }

  private async send(request: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: string | Uint8Array;
    headers?: Record<string, string>;
  }): Promise<HttpResponse> {
    const credentials = Buffer.from(
      `${this.options.email}:${this.options.apiToken}`,
      'utf8',
    ).toString('base64');

    const response = await this.client.send({
      url: request.url,
      method: request.method,
      ...(request.body === undefined ? {} : { body: request.body }),
      headers: {
        authorization: `Basic ${credentials}`,
        accept: 'application/json',
        'user-agent': this.options.userAgent ?? 'issue-bridge',
        ...request.headers,
      },
    });

    if (response.status >= 200 && response.status < 300) return response;
    throw toMigrationError(response, request.url);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, body: string, path: string): z.output<S> {
    let payload: unknown;
    try {
      payload = body.trim().length === 0 ? null : JSON.parse(body);
    } catch (cause: unknown) {
      throw new MigrationError({
        code: 'unknown',
        message: `Non-JSON response from ${path}.`,
        cause,
      });
    }

    const result = schema.safeParse(payload);
    if (result.success) return result.data;

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
 * Traduz falha do Jira para a taxonomia do core.
 *
 * O 400 do Jira é o caso mais importante: é como ele reporta campo obrigatório
 * ausente e valor inválido de custom field. A mensagem preserva `errorMessages`
 * e `errors` para o relatório apontar exatamente qual campo reprovou.
 */
export function toMigrationError(response: HttpResponse, rawUrl: string): MigrationError {
  // Nunca interpolar a URL crua: a query string pode carregar conteúdo privado.
  const url = redactUrl(rawUrl);
  const detail = describeJiraError(response.body);
  const retryAfterMs = retryDelayMs(response.headers);

  if (response.status === 401) {
    return new MigrationError({
      code: 'auth',
      message: `Jira credentials are invalid or expired (401 from ${url}). ${detail}`,
    });
  }

  if (response.status === 403) {
    return new MigrationError({
      code: 'forbidden',
      message: `No Jira permission for ${url}. ${detail}`,
    });
  }

  if (response.status === 404) {
    return new MigrationError({
      code: 'not-found',
      message: `Resource not found in Jira: ${url}. ${detail}`,
    });
  }

  if (response.status === 409) {
    return new MigrationError({
      code: 'conflict',
      message: `Conflict in Jira at ${url}. ${detail}`,
    });
  }

  if (response.status === 429) {
    return new MigrationError({
      code: 'rate-limit',
      message: `Jira rate limit hit at ${url}. ${detail}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  if (response.status === 400 || response.status === 422) {
    return new MigrationError({
      code: 'validation',
      message: `Jira rejected the request at ${url}. ${detail}`,
    });
  }

  if (response.status >= 500) {
    return new MigrationError({
      code: 'transient',
      message: `Jira is unavailable (${String(response.status)}) at ${url}. ${detail}`,
    });
  }

  return new MigrationError({
    code: 'unknown',
    message: `Unexpected response ${String(response.status)} from ${url}. ${detail}`,
  });
}

/** `{"errorMessages":[…],"errors":{"customfield_10042":"…"}}` → texto legível. */
function describeJiraError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return summarizeBody(body);

    const { errorMessages, errors } = parsed as {
      errorMessages?: unknown;
      errors?: unknown;
    };

    const parts: string[] = [];
    if (Array.isArray(errorMessages)) parts.push(...errorMessages.map((item) => String(item)));
    if (typeof errors === 'object' && errors !== null) {
      for (const [field, message] of Object.entries(errors)) {
        parts.push(`${field}: ${String(message)}`);
      }
    }

    return parts.length > 0 ? parts.join(' | ') : summarizeBody(body);
  } catch {
    return summarizeBody(body);
  }
}

function multipartBody(boundary: string, file: FileUpload): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${sanitizeFilename(file.filename)}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(head.length + file.bytes.length + tail.length);
  body.set(head, 0);
  body.set(file.bytes, head.length);
  body.set(tail, head.length + file.bytes.length);
  return body;
}

/** Aspas e quebras de linha corromperiam o header do multipart. */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/["\r\n]/g, '').trim();
  return cleaned.length === 0 ? 'attachment' : cleaned;
}
