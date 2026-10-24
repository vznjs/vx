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
// asks the local index only which keys it holds (no local get / no
// isOutputsCurrent), and probes the remote for the rest: a run the local
// cache answers makes no remote call (M, 2026-10-15). Local-only
// runs are byte-identical to before; the caller gates on the layer's
// own `hasRemote`, so a third-party remote layer gets the overlap too.
// The two batch-probe hooks are OPTIONAL on the contract: a remote layer
// that implements neither still prefetches, per-hash.

import type { TaskNode } from '../graph/index.js'
import { maskedCommand } from '../util/index.js'
import type { CacheLayer, GitFilesCache } from '../cache/index.js'
import type { HashCache } from './task-hash.js'
import { deriveStableKeys, type StableKey } from './stable-keys.js'

export interface PrefetchArgs {
  nodes: Map<string, TaskNode>
  /** A layer whose `hasRemote` is true — the caller's gate. */
  cache: CacheLayer
  workspaceRoot: string
  /** The root files the plugins claim (`DeriveStableKeysArgs.claimedFiles`). */
  claimedFiles: readonly string[]
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  /** Cap on concurrent in-flight prefetches (`cache.concurrency.download`). */
  concurrency: number
  /** When false (remote reads disabled), no prefetch fires. */
  remoteRead: boolean
  /**
   * With reads off and writes on (`--force`), the keys go to
   * `probeBeforeUpload` instead, so a key a remote holds is not re-sent.
   */
  remoteWrite: boolean
  /**
   * Told once, after the probe, the stable tasks a store holds, local or
   * remote, and those every store answered it does not: they run.
   */
  held?: ((ids: readonly string[], missed: readonly string[]) => void) | undefined
  /** `--profile`'s run events: the keys' derivation and the batch probe, `ts` on `performance.now()`. */
  spans?: Record<string, unknown>[] | undefined
}

function span(spans: PrefetchArgs['spans'], name: string, start: number, args: object): void {
  const end = performance.now()
  spans?.push({
    name,
    cat: 'cache',
    ph: 'X',
    ts: start * 1000,
    dur: (end - start) * 1000,
    pid: 1,
    tid: 0,
    args,
  })
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
  if (!args.remoteRead) {
    if (!args.remoteWrite || args.cache.probeBeforeUpload === undefined) return Promise.resolve()
    const hashes = deriveStableKeys(args).then((keys) => [...new Set(keys.map((k) => k.hash))])
    args.cache.probeBeforeUpload(hashes)
    return hashes.then(
      () => {},
      () => {},
    )
  }
  // Detached from EXECUTION: the caller does NOT await this before
  // scheduling, so prefetch network latency overlaps the run. But the
  // caller DOES await the returned handle before closing the cache, so
  // a still-in-flight prefetch can never ingest into a closed DB. Errors
  // degrade inside LayeredCache.prefetch; the catch keeps the handle
  // from ever rejecting.
  return runPrefetch(args).catch(() => {})
}

async function runPrefetch(args: PrefetchArgs): Promise<void> {
  const keysAt = performance.now()
  const stableKeys = await deriveStableKeys(args)
  span(args.spans, 'stable keys', keysAt, { keys: stableKeys.length })
  // `complete`: every store asked answered for every key, so one it does
  // not hold is a miss; else only its hits are known.
  const tell = (holds: (hash: string) => boolean, complete: boolean): void =>
    args.held?.(
      stableKeys.filter((k) => holds(k.hash)).map((k) => k.node.id),
      complete ? stableKeys.filter((k) => !holds(k.hash)).map((k) => k.node.id) : [],
    )
  if (stableKeys.length === 0) {
    tell(() => false, true)
    return
  }

  // Batch existence probe FIRST (when the remote supports it): one round-trip
  // tells us which of the N stable hashes exist remotely, so we GET only the
  // hits and pre-mark the misses — their lazy `get` then short-circuits with
  // no network. This collapses N probe waves into 1 and skips every GET that
  // would 404. When the remote can't batch (`null` — an older remote, reads
  // disabled, or a layer that doesn't implement the hook at all), fall back to
  // prefetching every stable key, exactly as before.
  const held =
    (await args.cache.localHasMany?.([...new Set(stableKeys.map((k) => k.hash))])) ?? null
  let toPrefetch = held === null ? stableKeys : stableKeys.filter((k) => !held.has(k.hash))
  if (toPrefetch.length === 0) {
    tell(() => true, true)
    return
  }
  const uniqueHashes = [...new Set(toPrefetch.map((k) => k.hash))]
  const pool = fetchPool(args.concurrency, (k) =>
    args.cache.prefetch(k.hash, getContext(k.node, k.node.config.exec?.command ?? '')),
  )
  // Trusted at once: a key the index says a remote holds is a hit and its
  // pull starts now, before any remote answers (M, 2026-10-23). The probe
  // below still asks for all of them.
  // One that knows none of them says nothing: a fresh CI runner's empty
  // index called every key a miss, and main asked 15 workers for 16 misses
  // (75f58f9, 2026-10-23). The probe answers them.
  const kept = args.cache.remoteKnown?.(uniqueHashes)
  const known = kept === undefined || kept.size === 0 ? undefined : kept
  if (known !== undefined) pool.push(toPrefetch.filter((k) => known.has(k.hash)))
  const probeAt = performance.now()
  const asked = args.cache.remoteHasMany?.(uniqueHashes)
  // The first keys in graph order are pulled now too, the probe unanswered:
  // on CI it answered ~490 ms in, after a GET did (~250 ms), and a hit's
  // dependant waited on its own GET once its upstream hit landed
  // (2026-10-24). At most one pool's worth of these can 404.
  const eager = toPrefetch.filter((k) => known?.has(k.hash) !== true).slice(0, args.concurrency)
  if (asked !== undefined) pool.push(eager)
  // Demand hears the index only when no probe will answer: a key the
  // index lacks may still be held (a PR's CI stored main's next tree), and
  // calling it a miss asked 14 workers for 71 tasks, 17 of which ran
  // (main 7391c93, 2026-10-23). The probe is one round-trip.
  const early = known !== undefined && asked === undefined
  if (early) tell((h) => held?.has(h) === true || known.has(h), true)

  // Batch existence probe (when the remote supports it): one round-trip
  // tells us which of the N stable hashes exist remotely, so we GET only the
  // hits and pre-mark the misses — their lazy `get` then short-circuits with
  // no network. This collapses N probe waves into 1 and skips every GET that
  // would 404. When the remote can't batch (`null` — an older remote, reads
  // disabled, or a layer that doesn't implement the hook at all), fall back to
  // prefetching every stable key, exactly as before.
  // A remote that answered no batch query is asked key by key when demand
  // plans on the answer: main f71b377 asked 15 workers for 116 tasks, 107
  // restored, and small#1 joined to nothing (2026-10-23). A run that plans
  // nothing pulls instead, as before.
  let present = (await asked) ?? null
  if (asked !== undefined)
    span(args.spans, 'remote probe', probeAt, {
      keys: uniqueHashes.length,
      held: present?.size ?? null,
    })
  if (present === null && args.held !== undefined && asked !== undefined)
    present = (await args.cache.remoteHasEach?.(uniqueHashes, args.concurrency)) ?? null
  if (!early) tell((h) => held?.has(h) === true || present?.has(h) === true, present !== null)
  if (present !== null) {
    args.cache.markRemoteAbsent?.(uniqueHashes.filter((h) => !present.has(h)))
    // The pre-mark above already answers a pull for an absent hash from
    // the in-flight map, so on the wire this filter is the pump's
    // economy: deleting it alone GETs nothing extra, deleting both GETs
    // every absent key. What it decides is which hashes the pump asks
    // the layer for, and that is what the row pins (item 643, 645).
    toPrefetch = toPrefetch.filter((k) => present.has(k.hash))
  }
  const pulled = new Set(asked === undefined ? [] : eager)
  pool.push(toPrefetch.filter((k) => known?.has(k.hash) !== true && !pulled.has(k)))
  await pool.settled()
}

/**
 * Bounded worker pool over the keys to fetch, fed as they are known. Each
 * prefetch is self-contained (LayeredCache owns the in-flight map +
 * ingest); the cap keeps a 1000-task run from opening 1000 sockets at
 * once. The pumps race alongside execution.
 */
function fetchPool(
  concurrency: number,
  fetch: (k: StableKey) => Promise<boolean>,
): { push(keys: readonly StableKey[]): void; settled(): Promise<unknown> } {
  const cap = Math.max(1, concurrency)
  const queue: StableKey[] = []
  const pumps: Promise<void>[] = []
  let next = 0
  let active = 0
  const pump = async (): Promise<void> => {
    active++
    try {
      while (next < queue.length) await fetch(queue[next++]!).catch(() => false)
    } finally {
      active--
    }
  }
  return {
    push(keys) {
      queue.push(...keys)
      const room = Math.min(cap - active, queue.length - next)
      for (let i = 0; i < room; i++) pumps.push(pump())
    },
    settled: () => Promise.all(pumps),
  }
}

/**
 * What a cache lookup is told about the task: its id and command for the
 * row a remote hit inserts, and its declared outputs, the only names a
 * remote artifact may carry (item 942). Shared with execute-task's own
 * lookup, the other one that can reach a remote.
 */
export function getContext(node: TaskNode, command: string) {
  const outputs = node.config.cache?.outputs
  let masked: string | undefined
  return {
    taskId: node.id,
    // Stored in the entry row a remote hit inserts: masked as a save's is,
    // or the token a config inlined sat in cache.db (L-27). Masked on the
    // first read: only an adopt or a remote hit reads it, and masking every
    // lookup's command cost a cold 1,090-package run ~20 ms before its
    // first task.
    get command() {
      return (masked ??= maskedCommand(command, node.config.exec?.env))
    },
    outputs: { files: outputs?.files ?? [], workspaceFiles: outputs?.workspaceFiles ?? [] },
  }
}
