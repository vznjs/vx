// Eviction by age (README.md § Eviction): a Cron Trigger on Workers, a
// timer on Bun. Age is time since the write, not the last read: tracking
// reads would cost a D1 row write per hit, which the free plan counts.

import type { Blobs, Store } from './store.js'

export interface Retention {
  /** Days the trusted scope keeps an artifact (default 30). */
  readonly trustedDays?: number
  /** Days a branch's scope keeps one (default 7): a branch is short-lived. */
  readonly branchDays?: number
  /** Days a run stays in the history (default 90). */
  readonly runDays?: number
}

const DAY_MS = 86_400_000
/**
 * Rows one pass deletes: their blobs are deleted at once, and a Worker on
 * the free plan makes at most 1000 calls to Cloudflare's services a request.
 */
const PASS = 200
/** Passes one sweep makes; the next sweep goes on where it stopped. */
const PASSES = 4

const VARS = {
  trustedDays: 'TRUSTED_DAYS',
  branchDays: 'BRANCH_DAYS',
  runDays: 'RUN_DAYS',
} as const

/**
 * `TRUSTED_DAYS`, `BRANCH_DAYS` and `RUN_DAYS` from the environment, each
 * defaulted; one that is not a number of days above 0 is refused.
 */
export function retentionFrom(env: object): Required<Retention> {
  const out = { trustedDays: 30, branchDays: 7, runDays: 90 }
  for (const [field, name] of Object.entries(VARS) as [keyof typeof VARS, string][]) {
    const v = (env as Record<string, unknown>)[name]
    if (typeof v !== 'string' || v === '') continue
    const n = Number(v)
    if (!(Number.isFinite(n) && n > 0))
      throw new Error(`${name}: not a number of days above 0: ${v}`)
    out[field] = n
  }
  return out
}

/**
 * Deletes what is older than its retention: each artifact's row first,
 * then its blob, and old runs. Any number of nodes may sweep at once. Returns how many artifacts and runs it deleted.
 */
export async function evict(
  store: Store,
  blobs: Blobs,
  r: Required<Retention>,
  now: number = Date.now(),
): Promise<{ artifacts: number; runs: number }> {
  // A sweep may come before any request has made the tables.
  await store.init()
  const trustedBefore = now - r.trustedDays * DAY_MS
  const branchBefore = now - r.branchDays * DAY_MS
  let artifacts = 0
  for (let pass = 0; pass < PASSES; pass++) {
    // Rows first, taken in one statement: a node sweeping at once takes
    // others, and a blob no row names is never read.
    const rows = await store.takeExpired(trustedBefore, branchBefore, PASS)
    await Promise.all(rows.map((x) => blobs.delete(x.blob)))
    artifacts += rows.length
    if (rows.length < PASS) break
  }
  const runs = await store.dropRuns(now - r.runDays * DAY_MS, PASS * PASSES)
  return { artifacts, runs }
}
