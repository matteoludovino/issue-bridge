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
  /** E.g. `https://acme.atlassian.net`. */
  baseUrl: string;
  /** Email of the Atlassian account that owns the API token. */
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
 * Jira Cloud REST v3 client: Basic auth, multipart attachment upload and translation
 * of native failures into `MigrationError`.
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

  /** For endpoints that respond 201/204 with no body (e.g. `POST /issueLink`). */
  async postVoid(path: string, body: unknown): Promise<void> {
    await this.send({
      url: this.resolve(path),
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Attachment upload: hand-built `multipart/form-data` (no dependency on
   * FormData/undici) plus the `X-Atlassian-Token: no-check` header, which Jira requires
   * for XSRF protection.
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
 * Maps Jira failures to the core error taxonomy.
 *
 * Jira's 400 is the most important case: it is how Jira reports a missing required
 * field or an invalid custom field value. The message keeps `errorMessages`
 * and `errors` so the report can point to exactly which field was rejected.
 */
export function toMigrationError(response: HttpResponse, rawUrl: string): MigrationError {
  // Never interpolate the raw URL: the query string may carry private content.
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

/** `{"errorMessages":[…],"errors":{"customfield_10042":"…"}}` → readable text. */
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

/** Quotes and line breaks would corrupt the multipart header. */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/["\r\n]/g, '').trim();
  return cleaned.length === 0 ? 'attachment' : cleaned;
}
