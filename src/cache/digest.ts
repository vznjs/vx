// Digest — the explicit content-address used by every cache layer.
//
// Lifted as a first-class type (architecture-review-2026-06.md §4.3)
// so storage backends become pluggable beneath CacheLayer: local FS,
// R2, S3, or a future REAPI CAS bridge all speak (hash, sizeBytes).
//
// Two practical wins from making this explicit:
//   1. sizeBytes is the truncation check at transport boundaries (HTTP
//      Content-Length, R2 ETag-by-size). Free correctness, free corrupt-
//      artifact-early-fail.
//   2. CASBackend.has(digest) can answer with just the metadata, no
//      bytes round-trip — what existence probes want.
//
// Why sizeBytes is `number` and not `bigint`: Bun.file().size returns
// number; JS Number safely represents integers to 2^53-1 (~9 PB); no
// real cache artifact gets there. Bigint would create the same
// JSON.stringify-throws nuisance we already navigated for ns timestamps.

export interface Digest {
  readonly hash: string
  readonly sizeBytes: number
}

export function makeDigest(hash: string, sizeBytes: number): Digest {
  if (!/^[0-9a-f]+$/i.test(hash)) {
    throw new Error(`invalid digest hash: ${JSON.stringify(hash)}`)
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`invalid digest sizeBytes: ${sizeBytes}`)
  }
  return { hash, sizeBytes }
}

export function digestEqual(a: Digest, b: Digest): boolean {
  return a.hash === b.hash && a.sizeBytes === b.sizeBytes
}

/** Stable wire format for logging / RPC: `hash/sizeBytes`. */
export function digestString(d: Digest): string {
  return `${d.hash}/${d.sizeBytes}`
}

export function parseDigest(s: string): Digest {
  const slash = s.indexOf('/')
  if (slash === -1) throw new Error(`invalid digest string: ${JSON.stringify(s)}`)
  return makeDigest(s.slice(0, slash), Number(s.slice(slash + 1)))
}
