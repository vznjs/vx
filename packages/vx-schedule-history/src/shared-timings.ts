// Task timings through the workspace's cache (design
// packages/vx/docs/design/shared-timings-2026-10.md): CI writes each
// task's p50 under its commit (a branch's under its scope); a run whose
// tasks lack timings on its branch imports the blob of its merge-base with
// the default branch into the shared store, once per repo, and on a branch
// its last commit's over it. The blob is untrusted: it
// can only order a run, never change what runs, and every refusal is
// silent (M: no extra runtime warnings).

import type { LocalHistoryProvider, PluginCache, TaskResources } from '@vzn/vx'

/**
 * How long an import may take. The run never waits on it (M, 2026-10-16:
 * it orders from local history and re-ranks when the import lands); only
 * the plugin's teardown does, so the rows land before the cache closes.
 */
const IMPORT_DEADLINE_MS = 500
/** Commits walked back from the merge-base (and from HEAD on write) for a blob. */
const WALK = 5
const MAX_BLOB_BYTES = 1024 * 1024
const MAX_TASKS = 50_000
const MAX_MS = 86_400_000
const MAX_CORES = 65_536
const MAX_BYTES = 2 ** 50

const keyOf = (sha: string): string => `timings\0${sha}`

/**
 * `sha`'s blob for one graph: each CI job of a commit writes the tasks of
 * its own graph, and the first job's plain blob wins, so a job whose tasks
 * another job's blob lacks (the dte job's shards) read none (2026-10-22).
 */
const graphKeyOf = (sha: string, ids: readonly string[]): string =>
  `timings\0${sha}\0${Bun.hash.xxHash3([...ids].sort().join('\0')).toString(16)}`

/** The keys `sha`'s blob may be under, the run's own graph's first. */
const keysOf = (sha: string, ids: readonly string[]): string[] => [graphKeyOf(sha, ids), keyOf(sha)]

/**
 * A blob's timings, the entries a run's graph has: `{ version: 1, tasks:
 * { id: ms } }`, each ms a finite number in [0, 24 h]; anything else is
 * dropped. Null for a blob that is not that shape, or over the caps.
 */
export function parseTimings(
  bytes: Uint8Array,
  graph: ReadonlySet<string>,
): Map<string, number> | null {
  return parseBlob(bytes, graph)?.timings ?? null
}

/**
 * `parseTimings`, and each timed task's measured need from the blob's
 * optional `needs: { id: { cpu, rss?, cores?, memory? } }` (`cpu` its most
 * cores busy, `rss` its peak memory, `cores` / `memory` the machine it
 * filled): what a fresh machine packs by. A need out of range is dropped.
 */
function parseBlob(
  bytes: Uint8Array,
  /** Null: every task's. */
  graph: ReadonlySet<string> | null,
): { timings: Map<string, number>; needs: Map<string, TaskResources> } | null {
  if (bytes.byteLength > MAX_BLOB_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks
  if (
    (parsed as { version?: unknown } | null)?.version !== 1 ||
    typeof tasks !== 'object' ||
    tasks === null ||
    Array.isArray(tasks)
  )
    return null
  const entries = Object.entries(tasks)
  if (entries.length > MAX_TASKS) return null
  const out = new Map<string, number>()
  for (const [id, ms] of entries) {
    if (
      typeof ms === 'number' &&
      Number.isFinite(ms) &&
      ms >= 0 &&
      ms <= MAX_MS &&
      (graph === null || graph.has(id))
    )
      out.set(id, ms)
  }
  const needs = new Map<string, TaskResources>()
  const raw = (parsed as { needs?: unknown }).needs
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
    for (const [id, n] of Object.entries(raw)) {
      if (!out.has(id) || typeof n !== 'object' || n === null) continue
      const { cpu, rss, cores, memory } = n as Record<string, unknown>
      if (!within(cpu, MAX_CORES) || cpu === 0) continue
      needs.set(id, {
        p50DurationMs: out.get(id),
        maxCpuParallelism: cpu,
        ...(within(rss, MAX_BYTES) ? { maxPeakRssBytes: rss } : {}),
        ...(within(cores, MAX_CORES) ? { saturatedCores: cores } : {}),
        ...(within(memory, MAX_BYTES) ? { saturatedMemoryBytes: memory } : {}),
      })
    }
  return { timings: out, needs }
}

const within = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

/** `git <args>`'s first lines in `root`, or null when it fails. */
async function git(root: string, args: readonly string[]): Promise<string[] | null> {
  const proc = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return null
  return out.split('\n').filter((l) => l !== '')
}

/** `sha` and up to `WALK - 1` of its first-parent ancestors, newest first. */
const lineage = (root: string, sha: string): Promise<string[] | null> =>
  git(root, ['rev-list', '--first-parent', `--max-count=${WALK}`, sha])

/** The merge-base of HEAD with the default branch: the local branch, else origin's. */
async function mergeBase(root: string, defaultBranch: string): Promise<string | null> {
  for (const ref of [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`]) {
    const base = await git(root, ['merge-base', 'HEAD', ref])
    if (base?.[0] !== undefined) return base[0]
  }
  return null
}

/**
 * The newest blob along `shas`, the default branch's lineage, so its entries
 * are the base branch's (`scoped` false): one batch probe, one fetch;
 * sequential fetches with no batch probe.
 */
async function newestBlob(
  cache: PluginCache,
  shas: readonly string[],
  ids: readonly string[],
): Promise<Uint8Array | null> {
  const present = await cache.hasMany(
    shas.flatMap((sha) => keysOf(sha, ids)),
    false,
  )
  for (const sha of shas) {
    for (const key of keysOf(sha, ids)) {
      if (present !== null && !present.has(key)) continue
      const got = await cache.get(key, false)
      if (got !== null) return got
      if (present !== null) return null
    }
  }
  return null
}

export interface ImportArgs {
  readonly root: string
  readonly defaultBranch: string
  readonly cache: PluginCache
  readonly provider: LocalHistoryProvider
  readonly ids: readonly string[]
  /** Holds the last merge-base asked, so one with no blob is asked once. */
  readonly triedFile: string
  /** The run is on a branch: also import its last commit's blob, scoped. */
  readonly branch: boolean
}

/**
 * Import the merge-base's timings once per merge-base, and on a branch its
 * last commit's: each unless a row already carries that commit or its
 * tried file names it. Gives up after `IMPORT_DEADLINE_MS`. Resolves true
 * when rows were added. The caller asks only when its forecast read lacked
 * some branch timing.
 */
export async function importTimings(args: ImportArgs): Promise<boolean> {
  let late = false
  const isLate = (): boolean => late
  const work = (async (): Promise<boolean> => {
    const base = await importBase(args, isLate)
    if (!args.branch || late) return base
    return (await importParent(args, isLate)) || base
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      late = true
      resolve(false)
    }, IMPORT_DEADLINE_MS)
  })
  try {
    return await Promise.race([work.catch(() => false), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** The merge-base's lineage blob, once per merge-base. */
async function importBase(args: ImportArgs, late: () => boolean): Promise<boolean> {
  const base = await mergeBase(args.root, args.defaultBranch)
  if (base === null || args.provider.hasImported(base)) return false
  if ((await readTried(args.triedFile)) === base) return false
  const shas = await lineage(args.root, base)
  if (shas === null) return false
  const blob = await newestBlob(args.cache, shas, args.ids)
  if (late()) return false
  await Bun.write(args.triedFile, base).catch(() => {})
  return keep(args, base, blob)
}

/**
 * The branch's last commit's blob (M, 2026-10-18): one scoped read of
 * HEAD's parent, which CI on the branch wrote. Imported after the
 * merge-base's, so its rows are the newer and override main's per task;
 * a task it lacks keeps main's.
 */
async function importParent(args: ImportArgs, late: () => boolean): Promise<boolean> {
  const parent = (await git(args.root, ['rev-parse', '--verify', '-q', 'HEAD^']))?.[0]
  if (parent === undefined || args.provider.hasImported(parent)) return false
  const tried = `${args.triedFile}-branch`
  if ((await readTried(tried)) === parent) return false
  let blob: Uint8Array | null = null
  for (const key of keysOf(parent, args.ids)) if ((blob = await args.cache.get(key)) !== null) break
  if (late()) return false
  await Bun.write(tried, parent).catch(() => {})
  return keep(args, parent, blob)
}

const readTried = (file: string): Promise<string> =>
  Bun.file(file)
    .text()
    .catch(() => '')

/** Keep `blob`'s timings as `sha`'s rows; true when any were added. */
function keep(args: ImportArgs, sha: string, blob: Uint8Array | null): boolean {
  const parsed = blob === null ? null : parseBlob(blob, new Set(args.ids))
  if (parsed === null) return false
  args.provider.importTimings(sha, parsed.timings, parsed.needs)
  return parsed.timings.size > 0
}

export interface ExportArgs {
  readonly root: string
  readonly cache: PluginCache
  readonly provider: LocalHistoryProvider
  readonly ids: readonly string[]
}

/**
 * Write HEAD's blob: every task of the newest blob along HEAD's lineage,
 * with each graph task's forecast after the run over it, so whichever of a
 * commit's blobs a run reads holds every task, and a job whose task set
 * changed still finds its tasks (owner, 2026-10-22). Never replaces a blob.
 */
export async function exportTimings(args: ExportArgs): Promise<void> {
  const head = await git(args.root, ['rev-parse', 'HEAD'])
  if (head?.[0] === undefined) return
  const p50s = await args.provider.p50sFor(args.ids)
  if (p50s.size === 0) return
  const measured = await args.provider.resourcesFor(args.ids)
  const shas = await lineage(args.root, head[0])
  const prior = shas === null ? null : await newestBlob(args.cache, shas, args.ids)
  const carried = prior === null ? null : parseBlob(prior, null)
  const timings = new Map(carried?.timings)
  const resources = new Map(carried?.needs)
  for (const [id, ms] of p50s) {
    timings.set(id, ms)
    const r = measured.get(id)
    if (r?.maxCpuParallelism !== undefined) resources.set(id, r)
  }
  let bytes = encode(timings, resources)
  // Tasks a repo dropped stay in the carried blob; past the cap, the run's own.
  if (bytes.byteLength > MAX_BLOB_BYTES) {
    const own = (id: string): boolean => p50s.has(id)
    bytes = encode(
      new Map([...timings].filter(([id]) => own(id))),
      new Map([...resources].filter(([id]) => own(id))),
    )
  }
  for (const key of keysOf(head[0], args.ids)) await args.cache.put(key, bytes)
}

/** `{ version: 1, tasks, needs? }`, each map by task id. */
function encode(
  timings: ReadonlyMap<string, number>,
  resources: ReadonlyMap<string, TaskResources>,
): Uint8Array {
  const tasks: Record<string, number> = {}
  const needs: Record<string, Record<string, number>> = {}
  for (const [id, ms] of [...timings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    tasks[id] = Math.round(ms)
    const r = resources.get(id)
    if (r?.maxCpuParallelism === undefined) continue
    needs[id] = {
      cpu: Math.round(r.maxCpuParallelism * 100) / 100,
      ...(r.maxPeakRssBytes === undefined ? {} : { rss: r.maxPeakRssBytes }),
      ...(r.saturatedCores === undefined ? {} : { cores: r.saturatedCores }),
      ...(r.saturatedMemoryBytes === undefined ? {} : { memory: r.saturatedMemoryBytes }),
    }
  }
  const blob =
    Object.keys(needs).length === 0 ? { version: 1, tasks } : { version: 1, tasks, needs }
  return new TextEncoder().encode(JSON.stringify(blob))
}
