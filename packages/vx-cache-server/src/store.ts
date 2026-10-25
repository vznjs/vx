// Where a server keeps what it is sent: one bucket (S3 or R2), no
// database (M, 2026-10-25). An artifact is one object whose name is its
// issuer, repository id, scope and hash and whose size is the bucket's
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
}

/**
 * An artifact's object name, `<issuer>/<id>/<scope>/<hash>` (M,
 * 2026-10-25), the first three each hashed (`partOf`) so a ref's slashes
 * or any byte stay one segment. The server knows no tier, and a name
 * tells nothing of what it holds.
 */
export const blobName = async (
  issuer: string,
  id: string,
  scope: string,
  hash: string,
): Promise<string> => `${await partOf(issuer)}/${await partOf(id)}/${await partOf(scope)}/${hash}`

const parts = new Map<string, Promise<string>>()

/**
 * One name segment: SHA-256's first 128 bits in hex. Web Crypto, so Bun
 * and Workers name alike; a few strings recur per node, so each is
 * hashed once.
 */
function partOf(text: string): Promise<string> {
  let got = parts.get(text)
  if (got === undefined) {
    if (parts.size >= 10_000) parts.clear()
    got = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(text))
      .then((d) =>
        [...new Uint8Array(d, 0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      )
    parts.set(text, got)
  }
  return got
}
