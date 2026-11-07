// Where a server keeps what it is sent: one bucket (S3 or R2), no
// database (2026-10-25). An artifact is one object whose name is its
// issuer, repository name, ref and hash and whose size is the bucket's
// own, so any number of nodes share a bucket and nothing else.

/** A blob's bytes and its size, as the bucket holds them. */
export interface Blob {
  readonly body: ReadableStream<Uint8Array>
  readonly size: number
}

/** A bucket of blobs by name; a put replaces a name whole. */
export interface Blobs {
  /** Stores `size` bytes; rejects when the stream ends at another length. */
  put(name: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>
  /** The blob, or null when the bucket has none by that name. */
  get(name: string): Promise<Blob | null>
  /** Its size, read off its metadata, or null when there is none. */
  size(name: string): Promise<number | null>
  /**
   * This request's reads so far: how many a cache in front of the
   * bucket answered (`edge`) and how many the bucket did. Only a store
   * with such a cache counts (the Worker's data center cache).
   */
  reads?(): { edge: number; bucket: number }
}

/**
 * An artifact's object name, `<issuer>/<repository>/<ref>/<hash>`, each
 * a readable folder (2026-11-03: pruning one branch is deleting its
 * prefix). Issuer and repository are percent-encoded here and `scope` is
 * the ref as the wire sends it, already encoded, so a slash or any other
 * byte never starts another folder.
 */
export const blobName = (issuer: string, repository: string, scope: string, hash: string): string =>
  `${encodeURIComponent(issuer)}/${encodeURIComponent(repository)}/${scope}/${hash}`
