// Where a server keeps what it is sent: one bucket (S3 or R2), no
// database (M, 2026-10-25). An artifact is one object whose name is its
// repository, scope and hash and whose size is the bucket's own, so any
// number of nodes share a bucket and nothing else.

import { TRUSTED } from '@vzn/vx-devtools'

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
}

/**
 * An artifact's object name: `trusted/<repo>/<hash>` or
 * `branch/<repo>/<ref>/<hash>`. The first segment is what a lifecycle rule
 * matches, so each scope expires on its own clock with no sweep.
 */
export const blobName = (repo: string, scope: string, hash: string): string =>
  scope === TRUSTED
    ? `trusted/${encodeURIComponent(repo)}/${hash}`
    : `branch/${encodeURIComponent(repo)}/${encodeURIComponent(scope)}/${hash}`
