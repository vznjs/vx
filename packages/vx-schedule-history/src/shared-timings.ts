// Task timings through the workspace's cache (design
// packages/vx/docs/design/shared-timings-2026-10.md): CI writes each
// task's p50 under its commit (a branch's under its scope); a run whose
// tasks lack timings on its branch imports the blob of its merge-base with
// the default branch into the shared store, once per repo, and on a branch
// its last commit's over it. The blob is untrusted: it
// can only order a run, never change what runs, and every refusal is
// silent (M: no extra runtime warnings).

import {
  type LocalHistoryProvider,
  mergeBaseWith,
  type PluginCache,
  type TaskResources,
} from '@vzn/vx'

/**
 * How long an import may take. The run never waits on it (M, 2026-10-16:
 * it orders from local history and re-ranks when the import lands), and
 * its teardown stops it (M, 2026-10-23: "without dte we should not wait
 * for hisotry"). Only a plugin sizing the run by it (`ctx.refining()`,
 * vx-dte) waits, this long at most: 500 ms on CI left a main run's 107
 * tasks unmeasured, each asking for a whole worker (2026-10-23).
 */
const IMPORT_DEADLINE_MS = 5_000
/** Commits walked back from the merge-base (and from HEAD on write) for a blob. */
const WALK = 5
const MAX_BLOB_BYTES = 1024 * 1024
const MAX_TASKS = 50_000
const MAX_MS = 86_400_000
const MAX_CORES = 65_536
const MAX_BYTES = 2 ** 50
const MAX_DEF = 64
/** The share of its machine's cores a task must keep busy to fill it (core's history). */
const SATURATED = 0.9

const keyOf = (sha: string): string => `timings\0${sha}`

/**
 * Blobs one commit's runs of one graph keep: a rerun, a push and its PR,
 * two workflows (M, 2026-10-24). A run writes the lowest free one, so a
 * later slot is a later run; an entry is written once.
 */
const SLOTS = 8

/**
 * Each CI job of a commit writes the tasks of its own graph, and the first
 * job's plain blob wins, so a job whose tasks another job's blob lacks (the
 * dte job's shards) read none (2026-10-22).
 */
const graphOf = (ids: readonly string[]): string =>
  Bun.hash.xxHash3([...ids].sort().join('\0')).toString(16)

const slotKeyOf = (sha: string, graph: string, slot: number): string =>
  `timings\0${sha}\0${graph}${slot === 0 ? '' : `\0${slot}`}`

/** The keys `sha`'s blob may be under, the run's own graph's newest slot first. */
const keysOf = (sha: string, ids: readonly string[]): string[] => {
  const graph = graphOf(ids)
  const keys: string[] = []
  for (let slot = SLOTS - 1; slot >= 0; slot--) keys.push(slotKeyOf(sha, graph, slot))
  keys.push(keyOf(sha))
  return keys
}

/**
 * A blob's timings, the entries a run's graph has: `{ version: 4, tasks:
 * { id: ms } }` (or 1 to 3), each ms a finite number in [0, 24 h]; anything else is
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
 * `defs: { id: definition }` says which task each timing is of
 * (`taskDefinitions`); a reader keeps only a timing of the task as it is now.
 */
const VERSIONS: ReadonlySet<unknown> = new Set([1, 2, 3, 4])

function parseBlob(
  bytes: Uint8Array,
  /** Null: every task's. */
  graph: ReadonlySet<string> | null,
): {
  timings: Map<string, number>
  needs: Map<string, TaskResources>
  defs: Map<string, string>
  /** The run's own times, which a later write folds in when this blob was skipped. */
  ran: Map<string, number>
  /** The runs it holds (`sha:graph:slot`); absent, its own and every older one. */
  has: Set<string> | null
} | null {
  if (bytes.byteLength > MAX_BLOB_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
    // quiet: not JSON: keep() says the blob is unreadable
  } catch {
    return null
  }
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks
  if (
    !VERSIONS.has((parsed as { version?: unknown } | null)?.version) ||
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
  // An older blob's needs are wrong: version 1 learned a crowded worker's
  // share of a core (main c27c238 packed nine test shards on 4 cores),
  // version 2 a macOS worker's use, which reported no share, and a hit's
  // producer's (main 357d3aa packed six Mac shards on 3 cores), and
  // version 3 a Mac share read below its free cores, so a shard asked 2.2
  // cores and used 0.5 (main 3917881). Its timings stand, its needs do not.
  const raw =
    (parsed as { version: number; needs?: unknown }).version !== 4
      ? undefined
      : (parsed as { needs?: unknown }).needs
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
  const defs = new Map<string, string>()
  const rawDefs = (parsed as { defs?: unknown }).defs
  if (typeof rawDefs === 'object' && rawDefs !== null && !Array.isArray(rawDefs))
    for (const [id, d] of Object.entries(rawDefs))
      if (out.has(id) && typeof d === 'string' && d.length <= MAX_DEF) defs.set(id, d)
  const ran = new Map<string, number>()
  const rawRan = (parsed as { ran?: unknown }).ran
  if (typeof rawRan === 'object' && rawRan !== null && !Array.isArray(rawRan))
    for (const [id, ms] of Object.entries(rawRan))
      if (out.has(id) && within(ms, MAX_MS)) ran.set(id, ms)
  const rawHas = (parsed as { has?: unknown }).has
  const has =
    Array.isArray(rawHas) && rawHas.length <= WALK * SLOTS
      ? new Set(rawHas.filter((id): id is string => typeof id === 'string' && RUN_ID.test(id)))
      : null
  return { timings: out, needs, defs, ran, has }
}

/** A run's blob: `sha:graph:slot`. */
const RUN_ID = /^[0-9a-f]{40,64}:[0-9a-f]{1,16}:[0-9]$/

const within = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

/** `git <args>`'s first lines in `root`, or null when it fails. */
async function git(root: string, args: readonly string[]): Promise<string[] | null> {
  const proc = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return null
  return out.split('\n').filter((l) => l !== '')
}

/**
 * `sha` and up to `WALK - 1` of its first-parent ancestors, newest first.
 * A shallow clone (CI's one-commit checkout) holds none of them: their
 * commits are fetched from origin, no blobs, and a failed fetch throws.
 */
async function lineage(root: string, sha: string): Promise<string[] | null> {
  const walk = ['rev-list', '--first-parent', `--max-count=${WALK}`, sha]
  const held = await git(root, walk)
  if (held === null || held.length >= WALK) return held
  if ((await git(root, ['rev-parse', '--is-shallow-repository']))?.[0] !== 'true') return held
  const fetch = Bun.spawn(
    [
      'git',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      '--filter=blob:none',
      `--depth=${WALK}`,
      'origin',
      sha,
    ],
    {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const [err, code] = await Promise.all([new Response(fetch.stderr).text(), fetch.exited])
  if (code !== 0)
    throw new Error(`git fetch of ${sha.slice(0, 12)}'s history failed: ${err.trim()}`)
  return git(root, walk)
}

/**
 * The merge-base of HEAD with the default branch: the local branch, else
 * origin's, which a shallow clone (CI's one-commit checkout) fetches.
 */
async function mergeBase(root: string, defaultBranch: string): Promise<string | null> {
  const local = await git(root, ['merge-base', 'HEAD', `refs/heads/${defaultBranch}`])
  if (local?.[0] !== undefined) return local[0]
  return (await mergeBaseWith(root, `origin/${defaultBranch}`)) ?? null
}

/**
 * The newest blob along `shas`, the default branch's lineage, so its entries
 * are the base branch's (`scoped` false): one batch probe, one fetch;
 * sequential fetches with no batch probe. `holds` says whether a key is
 * stored: the probe's answer, else one `has`.
 */
async function newestAlong(
  cache: PluginCache,
  shas: readonly string[],
  ids: readonly string[],
): Promise<{
  /** Its index in `shas`, and its slot (-1 the plain blob). */
  at: number
  slot: number
  bytes: Uint8Array | null
  holds: (key: string) => Promise<boolean>
}> {
  const present = await cache.hasMany(
    shas.flatMap((sha) => keysOf(sha, ids)),
    false,
  )
  const holds = async (key: string): Promise<boolean> =>
    present !== null ? present.has(key) : (await cache.has(key, false)) === true
  for (const [at, sha] of shas.entries()) {
    for (const [k, key] of keysOf(sha, ids).entries()) {
      if (present !== null && !present.has(key)) continue
      const bytes = await cache.get(key, false)
      if (bytes !== null || present !== null) return { at, slot: SLOTS - 1 - k, bytes, holds }
    }
  }
  return { at: -1, slot: -1, bytes: null, holds }
}

async function newestBlob(
  cache: PluginCache,
  shas: readonly string[],
  ids: readonly string[],
): Promise<Uint8Array | null> {
  return (await newestAlong(cache, shas, ids)).bytes
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
  /** Resolves when the run ends: the import stops, keeping nothing more. */
  readonly stopped?: Promise<void>
  /** Where a failed import is said: the run orders without it, but not in silence. */
  readonly warn: (message: string) => void
}

/**
 * Import the merge-base's timings once per merge-base, and on a branch its
 * last commit's: each unless a row already carries that commit or its
 * tried file names it. Gives up after `IMPORT_DEADLINE_MS` or once
 * `stopped`. Resolves true
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
  const stopped = args.stopped?.then(() => {
    late = true
    return false
  })
  try {
    const failed = (err: unknown): false => {
      // Past the deadline or the run's end the import was given up: its
      // failure (the run's database closed under it) is no news.
      if (late) return false
      args.warn(
        `[vx] schedule-history: the shared timings could not be read: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
    return await Promise.race([work.catch(failed), deadline, ...(stopped ? [stopped] : [])])
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
  // quiet: a local marker; unwritten, the next run asks again
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
  // The commit names its parent where a shallow clone cut it off.
  const parent = (await git(args.root, ['cat-file', 'commit', 'HEAD']))
    ?.find((l) => l.startsWith('parent '))
    ?.slice('parent '.length)
  if (parent === undefined || args.provider.hasImported(parent)) return false
  const tried = `${args.triedFile}-branch`
  if ((await readTried(tried)) === parent) return false
  const keys = keysOf(parent, args.ids)
  const present = await args.cache.hasMany(keys)
  let blob: Uint8Array | null = null
  for (const key of keys) {
    if (present !== null && !present.has(key)) continue
    if ((blob = await args.cache.get(key)) !== null || present !== null) break
  }
  if (late()) return false
  // quiet: a local marker; unwritten, the next run asks again
  await Bun.write(tried, parent).catch(() => {})
  return keep(args, parent, blob)
}

const readTried = (file: string): Promise<string> =>
  Bun.file(file)
    .text()
    // quiet: a local marker; none read is none tried
    .catch(() => '')

/** Keep `blob`'s timings as `sha`'s rows; true when any were added. */
function keep(args: ImportArgs, sha: string, blob: Uint8Array | null): boolean {
  const parsed = blob === null ? null : parseBlob(blob, new Set(args.ids))
  if (parsed === null) {
    if (blob !== null)
      args.warn(
        `[vx] schedule-history: ${sha.slice(0, 12)}'s shared timings are unreadable (${blob.byteLength} B: past ${MAX_BLOB_BYTES} B or not a timings blob)`,
      )
    return false
  }
  args.provider.importTimings(sha, parsed.timings, parsed.needs, parsed.defs)
  return parsed.timings.size > 0
}

export interface ExportArgs {
  readonly root: string
  readonly cache: PluginCache
  readonly provider: LocalHistoryProvider
  readonly ids: readonly string[]
  /** The run's tasks' definitions (`taskDefinitions`), written beside their timings. */
  readonly defs: ReadonlyMap<string, string>
  /** The tasks the run executed: their times are its own, which a later write may fold in. */
  readonly ran: ReadonlySet<string>
}

/**
 * Write HEAD's blob: every task of the newest blob along HEAD's lineage,
 * with each graph task's forecast after the run over it, so whichever of a
 * commit's blobs a run reads holds every task, and a job whose task set
 * changed still finds its tasks (owner, 2026-10-22). Never replaces a blob.
 *
 * Two main runs in parallel race: a child that writes before its parent
 * carries the grandparent's blob, and the parent's lands where no reader
 * looks (M, 2026-10-24). So a blob names the commits whose runs it holds
 * (`has`) and keeps its run's own times (`ran`), and a write folds in each
 * blob of its lineage the newest lacks. With no race the newest holds
 * every older one and nothing more is fetched.
 */
export async function exportTimings(args: ExportArgs): Promise<void> {
  const head = await git(args.root, ['rev-parse', 'HEAD'])
  if (head?.[0] === undefined) return
  const measured = await args.provider.resourcesFor(args.ids)
  // A task the run only restored, never timed here: its producer's time.
  const p50s = new Map(await args.provider.p50sFor(args.ids))
  for (const [id, r] of measured)
    if (!p50s.has(id) && r.p50DurationMs !== undefined) p50s.set(id, r.p50DurationMs)
  if (p50s.size === 0) return
  const shas = (await lineage(args.root, head[0])) ?? [head[0]]
  const newest = await newestAlong(args.cache, shas, args.ids)
  const carried = newest.bytes === null ? null : parseBlob(newest.bytes, null)
  const timings = new Map(carried?.timings)
  const resources = new Map(carried?.needs)
  const defs = new Map(carried?.defs)
  const graph = graphOf(args.ids)
  // A blob that names no runs holds its own commit's earlier slots and
  // every older commit's.
  const covered = (i: number, slot: number): boolean =>
    carried === null
      ? false
      : carried.has !== null
        ? carried.has.has(`${shas[i]}:${graph}:${slot}`)
        : i > newest.at || (i === newest.at && slot <= newest.slot)
  // HEAD's own slots are the run's scope's (a branch's reruns write
  // there), probed last: the later the probe, the fewer runs of HEAD that
  // write between it and this run's put pick the same slot.
  let headPresent: Promise<Set<string> | null> | undefined
  const holds = async (i: number, key: string): Promise<boolean> => {
    if (i > 0) return newest.holds(key)
    const present = await (headPresent ??= args.cache.hasMany(
      Array.from({ length: SLOTS }, (_, slot) => slotKeyOf(head[0]!, graph, slot)),
    ))
    return present !== null ? present.has(key) : (await args.cache.has(key)) === true
  }
  const has: string[] = []
  let free: number | null = null
  // Oldest first, so a newer run's time weighs more.
  for (let i = shas.length - 1; i >= 0; i--) {
    const sha = shas[i]!
    for (let slot = 0; slot < SLOTS; slot++) {
      const key = slotKeyOf(sha, graph, slot)
      if (!(await holds(i, key))) {
        if (i === 0) free = slot
        break
      }
      has.push(`${sha}:${graph}:${slot}`)
      if (covered(i, slot)) continue
      const bytes = await args.cache.get(key, i > 0 ? false : undefined)
      const missed = bytes === null ? null : parseBlob(bytes, null)
      if (missed === null) continue
      for (const [id, ms] of missed.ran) {
        const def = args.defs.get(id) ?? defs.get(id)
        if (missed.defs.get(id) !== def) continue
        const was = timings.get(id)
        timings.set(id, was === undefined ? ms : Math.round((was + ms) / 2))
        const r = missed.needs.get(id)
        if (r !== undefined) resources.set(id, blend(resources.get(id), r))
      }
    }
  }
  for (const [id, ms] of p50s) {
    const def = args.defs.get(id)
    const same = defs.get(id) === def
    const was = same ? timings.get(id) : undefined
    // A run's time, averaged with the carried one: a CI run times a task
    // once, and check.build-cold took 17 s to 62 s on one Mac size; main
    // ef68f31 planned it at 14 s, the last run's, and ran 23 s over.
    timings.set(id, was === undefined ? ms : Math.round((was + ms) / 2))
    // A carried need of the task as it was is not this task's.
    if (!same) resources.delete(id)
    if (def === undefined) defs.delete(id)
    else defs.set(id, def)
    const r = measured.get(id)
    if (r?.maxCpuParallelism !== undefined) resources.set(id, blend(resources.get(id), r))
  }
  // Eight runs of one commit and graph already wrote: its plain blob stands.
  if (free !== null) has.push(`${head[0]}:${graph}:${free}`)
  const ran = new Map([...p50s].filter(([id]) => args.ran.has(id)))
  let bytes = encode(timings, resources, defs, ran, has)
  // Tasks a repo dropped stay in the carried blob; past the cap, the run's own.
  if (bytes.byteLength > MAX_BLOB_BYTES) {
    const own = (id: string): boolean => p50s.has(id)
    bytes = encode(
      new Map([...timings].filter(([id]) => own(id))),
      new Map([...resources].filter(([id]) => own(id))),
      defs,
      ran,
      has,
    )
  }
  if (free !== null) await args.cache.put(slotKeyOf(head[0], graph, free), bytes)
  await args.cache.put(keyOf(head[0]), bytes)
}

/**
 * A run's need, averaged with the one carried from earlier runs: a CI run
 * learns from its own executions only, so one crowded run's reading (a
 * build at 2.84 cores that uses 1.3 to 1.9) booked the next run a whole
 * 3-core Mac for it (main b5b83bb). It fills its machine only while the
 * average does, or both did.
 */
function blend(carried: TaskResources | undefined, run: TaskResources): TaskResources {
  if (carried?.maxCpuParallelism === undefined || run.maxCpuParallelism === undefined) return run
  const cpu = (carried.maxCpuParallelism + run.maxCpuParallelism) / 2
  const { saturatedCores, ...rest } = run
  const cores = saturatedCores ?? carried.saturatedCores
  const both = saturatedCores !== undefined && carried.saturatedCores !== undefined
  return {
    ...rest,
    maxCpuParallelism: cpu,
    ...(cores !== undefined && (both || cpu >= SATURATED * cores) ? { saturatedCores: cores } : {}),
  }
}

/** `{ version: 4, tasks, needs?, defs?, ran, has }`, each map by task id. */
function encode(
  timings: ReadonlyMap<string, number>,
  resources: ReadonlyMap<string, TaskResources>,
  defsById: ReadonlyMap<string, string>,
  ranById: ReadonlyMap<string, number>,
  has: readonly string[],
): Uint8Array {
  const tasks: Record<string, number> = {}
  const needs: Record<string, Record<string, number>> = {}
  const defs: Record<string, string> = {}
  for (const [id, ms] of [...timings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    tasks[id] = Math.round(ms)
    const def = defsById.get(id)
    if (def !== undefined) defs[id] = def
    const r = resources.get(id)
    if (r?.maxCpuParallelism === undefined) continue
    needs[id] = {
      cpu: Math.round(r.maxCpuParallelism * 100) / 100,
      ...(r.maxPeakRssBytes === undefined ? {} : { rss: r.maxPeakRssBytes }),
      ...(r.saturatedCores === undefined ? {} : { cores: r.saturatedCores }),
      ...(r.saturatedMemoryBytes === undefined ? {} : { memory: r.saturatedMemoryBytes }),
    }
  }
  const blob = {
    version: 4,
    tasks,
    ...(Object.keys(needs).length === 0 ? {} : { needs }),
    ...(Object.keys(defs).length === 0 ? {} : { defs }),
    ran: Object.fromEntries(
      [...ranById].filter(([id]) => id in tasks).map(([id, ms]) => [id, Math.round(ms)]),
    ),
    has,
  }
  return new TextEncoder().encode(JSON.stringify(blob))
}
