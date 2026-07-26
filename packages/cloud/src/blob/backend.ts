// The raw-storage seam under ArtifactStore (docs/design/s3-blob-backend-2026-07.md).
// The store keeps ALL policy — trust scopes, immutability, the streaming byte
// cap, the zstd-magic gate, hash validation — a backend only moves bytes.
// Keys mirror the local layout: `<bucket>/<tier>[/<sub>]/<hash>.tar.zst`.

/** Existence + metadata for one stored blob. */
export interface BlobStat {
  size: number
  /** ms epoch — when the blob landed in storage. */
  storedAt: number
  /**
   * vx metadata riding with the blob (`digest`, `durationMs`) when the
   * backend carries it inline (S3 user metadata). The local backend leaves
   * this empty — its sidecar FILES are read via `localPathFor`.
   */
  meta: Record<string, string>
}

/** One row of `list()` — key is relative to the store root. `list` reports
 *  every blob UNDER the prefix, at any depth (a scope prefix names a leaf
 *  scope; the workspace reaper passes a tenancy prefix spanning both tiers and
 *  every untrusted sub-scope). */
export interface BlobListEntry {
  key: string
  size: number
  storedAt: number
  /** Sidecar duration when the backend has it cheap (local); omitted on S3
   *  rather than paying one HEAD per row. */
  durationMs?: number
}

export interface BlobBackend {
  /** Existence + metadata probe; null = absent. Errors THROW — the store
   *  maps a throwing backend to a loud 502, never a silent miss. */
  head(key: string): Promise<BlobStat | null>
  /** Persist a spooled file (exact size known); `meta` rides with it. The
   *  STORE owns the spool file's lifetime (it unlinks after put returns). */
  put(key: string, file: string, size: number, meta: Record<string, string>): Promise<void>
  /** Remove a blob AND whatever sidecars the backend keeps beside it. A key
   *  that is already absent is NOT an error (delete is idempotent). Real
   *  failures THROW — the workspace reaper counts and logs them. */
  delete(key: string): Promise<void>
  /** A URL the CLIENT can GET directly (the 307 offload target), or null →
   *  the store serves the bytes itself (via `localPathFor`). */
  presignGet(key: string): Promise<string> | string | null
  /** Blobs under a scope prefix (no trailing slash). */
  list(prefix: string): Promise<BlobListEntry[]>
  /** Absolute filesystem path for a key when storage is a local dir — the
   *  store then serves bytes + sidecars directly; null when offloaded. */
  localPathFor(key: string): string | null
}
