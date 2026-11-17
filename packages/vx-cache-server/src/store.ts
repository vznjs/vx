import { hashPart } from '@vzn/vx-devtools'

// Where a server keeps what it is sent: one bucket (S3 or R2), no database. An
// artifact is one object whose name is the hashes of its issuer, repository
// name and ref, then its own hash, and whose size is the bucket's own, so any
// number of nodes share a bucket and nothing else.

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
  /**
   * Its size, read off its metadata, or null when there is none. `bucket`:
   * the bucket's own answer, never one a backend kept (an upload's skip,
   * which a stale "held" would drop).
   */
  size(name: string, bucket?: boolean): Promise<number | null>
}

/**
 * An artifact's object name, `<issuer>/<repository>/<ref>/<hash>`: the first
 * three each their `hashPart` (SHA-256's first 128 bits, 32 hex digits), so a
 * bucket's listing names no host, repository or branch, and every folder is one
 * fixed length whatever its name holds. `scope` is the ref as the wire sends
 * it, percent-encoded; the plain ref is what is hashed.
 */
export const blobName = async (
  issuer: string,
  repository: string,
  scope: string,
  hash: string,
): Promise<string> =>
  `${await hashPart(issuer)}/${await hashPart(repository)}/${await hashPart(decodeURIComponent(scope))}/${hash}`
