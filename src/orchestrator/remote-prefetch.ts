// Remote-cache prefetch (remote-only). When a run is backed by a
// LayeredCache, the network latency of every remote cache GET would
// otherwise sit on the critical path of the task that needs it. This
// module derives every cacheable task's pure-input key UP FRONT
// (reusing the run's hashCache memo, so execute-task's later
// computeTaskHash for the same task hits the memo — no double hashing)
// and fires the remote GETs concurrently, in the background, before
// execution starts. LayeredCache.prefetch ingests each hit into the
// LOCAL cache and de-dups against the lazy read-through, so when
// execute-task calls cache.get it transparently awaits the already
// in-flight (resolved-or-pending) remote promise — at most ONE remote
// GET per key.
//
// HARD SCOPE: this runs ONLY when a remote layer is configured. It
// NEVER touches the local cache (no local get / no isOutputsCurrent /
// no stat pass) — it derives keys and probes REMOTE only. Local-only
// runs are byte-identical to before; the caller gates on the layer's
// own `hasRemote`, so a third-party remote layer gets the overlap too.
// The two batch-probe hooks are OPTIONAL on the contract: a remote layer
// that implements neither still prefetches, per-hash.

import type { TaskNode } from '../graph/index.js'
import type { CacheLayer, GitFilesCache } from '../cache/index.js'
import type { HashCache } from './task-hash.js'
import { deriveStableKeys } from './stable-keys.js'

export interface PrefetchArgs {
  nodes: Map<string, TaskNode>
  /** A layer whose `hasRemote` is true — the caller's gate. */
  cache: CacheLayer
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  /** Cap on concurrent in-flight prefetches — the run's concurrency. */
  concurrency: number
  /** When false (remote reads disabled), no prefetch fires. */
  remoteRead: boolean
}

/**
 * Fire remote prefetches for every STABLE cached task in the graph.
 * Fire-and-forget from the caller's perspective: this kicks off an
 * async derivation + bounded prefetch pool and returns immediately so
 * execution starts concurrently. A remote-read-off policy short-circuits.
 *
 * Stability gate: see `deriveStableKeys` — a task's key is "stable"
 * only if its inputs can't be altered by an upstream task's outputs.
 * Unstable tasks fall back to lazy read-through in execute-task, which
 * is always correct.
 */
export function startRemotePrefetch(args: PrefetchArgs): Promise<void> {
  if (!args.remoteRead) return Promise.resolve()
  // Detached from EXECUTION: the caller does NOT await this before
  // scheduling, so prefetch network latency overlaps the run. But the
  // caller DOES await the returned handle before closing the cache, so
  // a still-in-flight prefetch can never ingest into a closed DB. Errors
  // degrade inside LayeredCache.prefetch; the catch keeps the handle
  // from ever rejecting.
  return runPrefetch(args).catch(() => {})
}

async function runPrefetch(args: PrefetchArgs): Promise<void> {
  const stableKeys = await deriveStableKeys(args)
  if (stableKeys.length === 0) return

  // Batch existence probe FIRST (when the remote supports it): one round-trip
  // tells us which of the N stable hashes exist remotely, so we GET only the
  // hits and pre-mark the misses — their lazy `get` then short-circuits with
  // no network. This collapses N probe waves into 1 and skips every GET that
  // would 404. When the remote can't batch (`null` — an older serve, reads
  // disabled, or a layer that doesn't implement the hook at all), fall back to
  // prefetching every stable key, exactly as before.
  let toPrefetch = stableKeys
  const uniqueHashes = [...new Set(stableKeys.map((k) => k.hash))]
  const present = (await args.cache.remoteHasMany?.(uniqueHashes)) ?? null
  if (present !== null) {
    args.cache.markRemoteAbsent?.(uniqueHashes.filter((h) => !present.has(h)))
    toPrefetch = stableKeys.filter((k) => present.has(k.hash))
    if (toPrefetch.length === 0) return
  }

  // Bounded worker pool over the keys to fetch. Each prefetch is
  // self-contained (LayeredCache owns the in-flight map + ingest); we
  // cap concurrency so a 1000-task run doesn't open 1000 sockets at
  // once. The pumps race alongside execution.
  let next = 0
  const workers = Math.max(1, Math.min(args.concurrency, toPrefetch.length))
  const pump = async (): Promise<void> => {
    while (next < toPrefetch.length) {
      const { hash, node } = toPrefetch[next++]!
      await args.cache
        .prefetch(hash, { taskId: node.id, command: node.config.exec?.command ?? '' })
        .catch(() => false)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => pump()))
}
