// A run's hits on their way into the history: a row of numbers and four
// strings each, packed as the hit settles (`HitBatch`), kept by the run as
// one `run_hits` row (`encodeHits`) and read back into `runs` rows only
// when a reader asks (`hitRecords`, run-history.ts `expandHits`). A record
// object and a `runs` row per hit were 13% of an 8,002-hit no-op.

import type { RunRecord } from './run-history.js'

/** A hit's numbers, by column; NaN is a field the row leaves out. */
export const HIT = {
  remote: 0,
  exitCode: 1,
  durationMs: 2,
  startNs: 3,
  endNs: 4,
  cached: 5,
  cacheHit: 6,
  restored: 7,
  cpuMs: 8,
  peakRssBytes: 9,
  peakCores: 10,
  avgRssBytes: 11,
  placementCores: 12,
  placementMemoryBytes: 13,
  cpuShare: 14,
  queuedMs: 15,
  outputBytes: 16,
  blocks: 17,
  flakyPasses: 18,
  flakyFailures: 19,
  attempts: 20,
  timedOut: 21,
  sandboxViolations: 22,
} as const
const WIDTH = 23
/** `HIT.remote`'s two statuses: which cache the hit came from. */
const LOCAL_HIT: RunRecord['status'] = 'cache-hit'
const REMOTE_HIT: RunRecord['status'] = 'cache-hit-remote'
/** A hit's strings, in order. */
const STRINGS = 4

/** The text fields few hits carry: sent only where set. */
export type RareHitField = 'placement' | 'blockedBy' | 'notReady' | 'remoteError' | 'keylessBy'

/** A batch of packed hits. */
export interface HitRows {
  n: number
  nums: Float64Array
  /** `project, task, hash, def` per hit; null where the row has none. */
  strs: (string | null)[]
  rare: [row: number, field: RareHitField, value: string][]
}

/** A batch being packed: `row` opens a hit, whose numbers go in at `nums[at + HIT.x]`. */
export class HitBatch implements HitRows {
  n = 0
  readonly nums: Float64Array
  readonly strs: (string | null)[] = []
  readonly rare: [number, RareHitField, string][] = []

  constructor(rows: number) {
    this.nums = new Float64Array(rows * WIDTH).fill(NaN)
  }

  /** Opens the next hit and returns where its numbers start. */
  row(project: string, task: string, hash: string | undefined, def: string | undefined): number {
    this.strs.push(project, task, hash ?? null, def ?? null)
    return this.n++ * WIDTH
  }

  set(field: RareHitField, value: string): void {
    this.rare.push([this.n - 1, field, value])
  }
}

/**
 * The `runs` rows of a batch: what `runRecordOf` builds for the same hits,
 * its spans as numbers (exact below 2^53 ns, 104 days into a run).
 */
export function hitRecords(
  rows: HitRows,
  run: { runId: string; startedAtMs: number },
): RunRecord[] {
  const { nums, strs } = rows
  const out: RunRecord[] = []
  for (let i = 0; i < rows.n; i++) {
    const at = i * WIDTH
    const s = i * STRINGS
    const num = (col: number): number | undefined => {
      const v = nums[at + col]!
      return Number.isNaN(v) ? undefined : v
    }
    const startNs = nums[at + HIT.startNs]!
    const endNs = nums[at + HIT.endNs]!
    const r: RunRecord = {
      project: strs[s]!,
      task: strs[s + 1]!,
      status: nums[at + HIT.remote] === 1 ? REMOTE_HIT : LOCAL_HIT,
      exitCode: nums[at + HIT.exitCode]!,
      durationMs: nums[at + HIT.durationMs]!,
      startedAt: run.startedAtMs + Math.round(startNs / 1e6),
      endedAt: run.startedAtMs + Math.round(endNs / 1e6),
      runId: run.runId,
      cached: nums[at + HIT.cached] === 1,
      // The insert binds them as numbers.
      wallclockStartNs: startNs as unknown as bigint,
      wallclockEndNs: endNs as unknown as bigint,
      restored: nums[at + HIT.restored] === 1,
    }
    if (nums[at + HIT.cacheHit] === 1) r.cacheHit = true
    const hash = strs[s + 2]
    if (hash != null) r.hash = hash
    const def = strs[s + 3]
    if (def != null) r.def = def
    for (const key of OPTIONAL) {
      const v = num(HIT[key])
      if (v !== undefined) r[key] = v
    }
    if (nums[at + HIT.timedOut] === 1) r.timedOut = true
    out.push(r)
  }
  for (const [i, field, value] of rows.rare) {
    const r = out[i]!
    if (field === 'notReady') r.notReady = value as NonNullable<RunRecord['notReady']>
    else r[field] = value
  }
  return out
}

const OPTIONAL = [
  'cpuMs',
  'peakRssBytes',
  'peakCores',
  'avgRssBytes',
  'placementCores',
  'placementMemoryBytes',
  'cpuShare',
  'queuedMs',
  'outputBytes',
  'blocks',
  'flakyPasses',
  'flakyFailures',
  'attempts',
  'sandboxViolations',
] as const satisfies readonly (keyof typeof HIT & keyof RunRecord)[]

/** A run's hits as `run_hits` stores them. */
export interface PackedHits {
  n: number
  /**
   * JSON: a `[project, task, hash, def]` per hit. Its own column, shared by
   * every run that hit the same keys in the same order, as successive
   * no-op runs do: SQL reads it (`json_each`) without the numbers.
   */
  keys: string
  /** zstd of a u32 count, the hits' numbers, then the rare fields as JSON. */
  nums: Uint8Array
}

/** Every batch of a run as one stored value. */
export function encodeHits(batches: readonly HitRows[]): PackedHits {
  let n = 0
  for (const b of batches) n += b.n
  const nums = new Float64Array(n * WIDTH)
  const keys: (string | null)[][] = []
  const rare: HitRows['rare'] = []
  let at = 0
  for (const b of batches) {
    nums.set(b.nums.subarray(0, b.n * WIDTH), at * WIDTH)
    for (let i = 0; i < b.strs.length; i += STRINGS) keys.push(b.strs.slice(i, i + STRINGS))
    for (const [row, field, value] of b.rare) rare.push([at + row, field, value])
    at += b.n
  }
  const text = new TextEncoder().encode(JSON.stringify(rare))
  const head = new Uint8Array(new Uint32Array([n]).buffer)
  const numBytes = new Uint8Array(nums.buffer)
  const raw = new Uint8Array(head.length + numBytes.length + text.length)
  raw.set(head, 0)
  raw.set(numBytes, head.length)
  raw.set(text, head.length + numBytes.length)
  return { n, keys: JSON.stringify(keys), nums: Bun.zstdCompressSync(raw, { level: 1 }) }
}

/** The rows `encodeHits` packed. */
export function decodeHits(packed: Pick<PackedHits, 'keys' | 'nums'>): HitRows {
  const raw = Bun.zstdDecompressSync(packed.nums)
  const n = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + 4))[0]!
  const numEnd = 4 + n * WIDTH * 8
  const nums = new Float64Array(raw.buffer.slice(raw.byteOffset + 4, raw.byteOffset + numEnd))
  const rare = JSON.parse(new TextDecoder().decode(raw.subarray(numEnd))) as HitRows['rare']
  return { n, nums, strs: (JSON.parse(packed.keys) as (string | null)[][]).flat(), rare }
}
