/** Attachment content already materialized in memory. */
export interface AttachmentPayload {
  filename: string;
  /** Resolved MIME type; `application/octet-stream` when the source does not provide one. */
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Attachment read port.
 *
 * Exists because attachments are the only data that crosses source → target as bytes:
 * the GitHub URL requires the GitHub token, and the target adapter must not
 * know the source's credential. The Executor downloads and hands over the ready content,
 * keeping the two adapters unaware of each other.
 *
 * Accepted trade-off: the whole attachment passes through process memory. For
 * very large files, the natural evolution is to replace `bytes` with an
 * `AsyncIterable<Uint8Array>` — the interface is the only thing that has to change.
 */
export interface AttachmentFetcher {
  fetch(url: string, filename: string): Promise<AttachmentPayload>;
}
