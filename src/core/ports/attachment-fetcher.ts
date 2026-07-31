/** Conteúdo de um anexo já materializado em memória. */
export interface AttachmentPayload {
  filename: string;
  /** MIME resolvido; `application/octet-stream` quando a origem não informa. */
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Porta de leitura de anexo.
 *
 * Existe porque anexo é o único dado que atravessa origem → destino como bytes:
 * a URL do GitHub exige o token do GitHub, e o adapter de destino não pode
 * conhecer a credencial da origem. O Executor baixa e entrega o conteúdo pronto,
 * mantendo os dois adapters ignorantes um do outro.
 *
 * Consequência assumida: o anexo passa inteiro pela memória do processo. Para
 * arquivos muito grandes, a evolução natural é trocar `bytes` por um
 * `AsyncIterable<Uint8Array>` — a interface é o único ponto a mudar.
 */
export interface AttachmentFetcher {
  fetch(url: string, filename: string): Promise<AttachmentPayload>;
}
