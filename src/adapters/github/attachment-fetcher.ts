import { MigrationError } from '../../core/errors.js';
import type { AttachmentFetcher, AttachmentPayload } from '../../core/ports/attachment-fetcher.js';
import { FetchHttpClient, type HttpClient } from '../http.js';
import { GitHubHttp, type GitHubHttpOptions } from './http.js';

/**
 * Baixa anexos do GitHub com a credencial da ORIGEM.
 *
 * Em repositório privado as URLs de `user-attachments`/`user-images` exigem
 * autenticação; sem isso o destino receberia HTML de login em vez do arquivo.
 */
export class GitHubAttachmentFetcher implements AttachmentFetcher {
  private readonly http: GitHubHttp;

  constructor(options: GitHubHttpOptions & { httpClient?: HttpClient }) {
    const { httpClient, ...httpOptions } = options;
    this.http = new GitHubHttp(httpClient ?? new FetchHttpClient(), httpOptions);
  }

  async fetch(url: string, filename: string): Promise<AttachmentPayload> {
    const { bytes, contentType } = await this.http.getBytes(url);

    if (bytes.length === 0) {
      throw new MigrationError({
        code: 'not-found',
        message: `Attachment "${filename}" came back empty; it was most likely deleted in the source.`,
      });
    }

    return {
      filename,
      contentType: normalizeContentType(contentType),
      bytes,
    };
  }
}

/** `image/png; charset=binary` → `image/png`. */
function normalizeContentType(raw: string | undefined): string {
  const value = raw?.split(';')[0]?.trim();
  return value === undefined || value.length === 0 ? 'application/octet-stream' : value;
}
