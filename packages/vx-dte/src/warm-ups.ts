// Each size's warm-up across runs, through the workspace's cache (M,
// 2026-10-23: "planner needs to use warmup from history"): a CI run writes
// the least time a worker of each size took to join under its commit, over
// the sizes it read; a run reads its newest first-parent ancestor's. Before
// any worker of a size joins, the plan waits that long for one, not 20 s:
// main fd5c72e's small workers joined in 15 s, its mac in 27 s. The blob is
// untrusted: it only sizes a plan, and a bad one reads as none.

import type { PluginCache } from '@vzn/vx'

/** Commits walked back from HEAD for a blob. */
const WALK = 6
const MAX_BYTES = 64 * 1024
const MAX_SIZES = 256
const MAX_MS = 3_600_000

const keyOf = (sha: string): string => `warm-ups\0${sha}`

/** `{ version: 1, sizes: { name: ms } }`'s warm-ups, each ms finite in [0, 1 h]; null for anything else. */
export function parseWarmUps(bytes: Uint8Array): Map<string, number> | null {
  if (bytes.byteLength > MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
    // quiet: not JSON reads as no blob
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { version, sizes } = parsed as { version?: unknown; sizes?: unknown }
  if (version !== 1 || typeof sizes !== 'object' || sizes === null || Array.isArray(sizes))
    return null
  const entries = Object.entries(sizes)
  if (entries.length > MAX_SIZES) return null
  const out = new Map<string, number>()
  for (const [name, ms] of entries)
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS) out.set(name, ms)
  return out
}

/** HEAD and its first-parent ancestors, newest first; none outside git. */
async function commits(root: string): Promise<string[]> {
  try {
    const proc = Bun.spawn({
      cmd: ['git', 'rev-list', '--first-parent', `--max-count=${WALK}`, 'HEAD'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return exit === 0 ? out.split('\n').filter((l) => l !== '') : []
    // quiet: a local git read; no commits reads no blob
  } catch {
    return []
  }
}

/** The newest warm-ups an ancestor's run wrote, the base branch's on a scoped run. */
export function readWarmUps(cache: PluginCache, root: string): Promise<Map<string, number>> {
  return newest(cache, root, keyOf, parseWarmUps)
}

/** The newest blob under an ancestor's `key` that `parse` reads; an empty map for none. */
async function newest(
  cache: PluginCache,
  root: string,
  key: (sha: string) => string,
  parse: (bytes: Uint8Array) => Map<string, number> | null,
): Promise<Map<string, number>> {
  const keys = (await commits(root)).map(key)
  if (keys.length === 0) return new Map()
  const held = await cache.hasMany(keys, false)
  for (const k of keys) {
    if (held !== null && !held.has(k)) continue
    const bytes = await cache.get(k, false)
    const got = bytes === null ? null : parse(bytes)
    if (got !== null) return got
  }
  return new Map()
}

/** `learned` with this run's own over it, under HEAD: once per commit, as every entry is. */
export function writeWarmUps(
  cache: PluginCache,
  root: string,
  learned: ReadonlyMap<string, number>,
  run: ReadonlyMap<string, number>,
): Promise<void> {
  return writeMs(cache, root, keyOf, learned, run)
}

// How much later each next worker of a size joined than the one before
// (`Orchestrator.spreadsMs`): before this run's own show it, the plan asks
// each next new one sooner by it. Kept as the warm-ups are, in their shape.

const spreadsKeyOf = (sha: string): string => `join-spreads\0${sha}`

/** The newest join spreads an ancestor's run wrote. */
export function readJoinSpreads(cache: PluginCache, root: string): Promise<Map<string, number>> {
  return newest(cache, root, spreadsKeyOf, parseWarmUps)
}

/** `learned` with this run's own over it, under HEAD. */
export function writeJoinSpreads(
  cache: PluginCache,
  root: string,
  learned: ReadonlyMap<string, number>,
  run: ReadonlyMap<string, number>,
): Promise<void> {
  return writeMs(cache, root, spreadsKeyOf, learned, run)
}

/** `{ version: 1, sizes: { name: ms } }` of `learned` with `run` over it, under HEAD's `key`. */
async function writeMs(
  cache: PluginCache,
  root: string,
  key: (sha: string) => string,
  learned: ReadonlyMap<string, number>,
  run: ReadonlyMap<string, number>,
): Promise<void> {
  if (run.size === 0) return
  const [head] = await commits(root)
  if (head === undefined) return
  const sizes: Record<string, number> = {}
  for (const [name, ms] of [...learned, ...run]) sizes[name] = Math.round(ms)
  await cache.put(key(head), new TextEncoder().encode(JSON.stringify({ version: 1, sizes })))
}

// Each server's base, the cores it uses with no dependant's work
// (`server-fit.ts`): booked once on each worker that starts it. Kept as
// the warm-ups are, under each CI run's commit; untrusted, it only books.

const MAX_SERVERS = 1024
/** More cores than any machine a run books. */
const MAX_CORES = 4096

const basesKeyOf = (sha: string): string => `server-bases\0${sha}`

/** `{ version: 1, servers: { id: cores } }`'s bases, each finite in [0, MAX_CORES]; null for anything else. */
export function parseServerBases(bytes: Uint8Array): Map<string, number> | null {
  return parseCores(bytes, 'servers')
}

/** `{ version: 1, [field]: { name: cores } }`'s cores, each finite in [0, MAX_CORES]; null for anything else. */
function parseCores(bytes: Uint8Array, field: 'servers' | 'sizes'): Map<string, number> | null {
  if (bytes.byteLength > MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
    // quiet: not JSON reads as no blob
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { version } = parsed as { version?: unknown }
  const named = (parsed as Record<string, unknown>)[field]
  if (version !== 1 || typeof named !== 'object' || named === null || Array.isArray(named))
    return null
  const entries = Object.entries(named)
  if (entries.length > MAX_SERVERS) return null
  const out = new Map<string, number>()
  for (const [id, cores] of entries)
    if (typeof cores === 'number' && Number.isFinite(cores) && cores >= 0 && cores <= MAX_CORES)
      out.set(id, cores)
  return out
}

/** The newest server bases an ancestor's run wrote. */
export function readServerBases(cache: PluginCache, root: string): Promise<Map<string, number>> {
  return newest(cache, root, basesKeyOf, parseServerBases)
}

/** `learned` with this run's own over it, under HEAD. */
export async function writeServerBases(
  cache: PluginCache,
  root: string,
  learned: ReadonlyMap<string, number>,
  run: ReadonlyMap<string, number>,
): Promise<void> {
  if (run.size === 0) return
  const [head] = await commits(root)
  if (head === undefined) return
  const servers: Record<string, number> = {}
  for (const [id, cores] of [...learned, ...run]) servers[id] = Math.round(cores * 100) / 100
  await cache.put(
    basesKeyOf(head),
    new TextEncoder().encode(JSON.stringify({ version: 1, servers })),
  )
}

// Each size's cores its machines spend besides the run's tasks
// (`Orchestrator.othersOf`): the plan leaves them out of each new worker
// of the size before one joins. Kept as the warm-ups are.

const othersKeyOf = (sha: string): string => `size-others\0${sha}`

/** `{ version: 1, sizes: { name: cores } }`'s cores, each finite in [0, MAX_CORES]; null for anything else. */
export function parseSizeOthers(bytes: Uint8Array): Map<string, number> | null {
  return parseCores(bytes, 'sizes')
}

/** The newest sizes' other cores an ancestor's run wrote. */
export function readSizeOthers(cache: PluginCache, root: string): Promise<Map<string, number>> {
  return newest(cache, root, othersKeyOf, parseSizeOthers)
}

/** `learned` with this run's own over it, under HEAD. */
export async function writeSizeOthers(
  cache: PluginCache,
  root: string,
  learned: ReadonlyMap<string, number>,
  run: ReadonlyMap<string, number>,
): Promise<void> {
  if (run.size === 0) return
  const [head] = await commits(root)
  if (head === undefined) return
  const sizes: Record<string, number> = {}
  for (const [name, cores] of [...learned, ...run]) sizes[name] = Math.round(cores * 100) / 100
  await cache.put(
    othersKeyOf(head),
    new TextEncoder().encode(JSON.stringify({ version: 1, sizes })),
  )
}
