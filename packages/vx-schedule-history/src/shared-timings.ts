// Task timings through the workspace's cache (design
// packages/vx/docs/design/shared-timings-2026-10.md): CI on the default
// branch writes each task's p50 under its commit; a run whose tasks lack
// timings on its branch imports the blob of its merge-base with the default
// branch into the shared store, once per repo. The blob is untrusted: it
// can only order a run, never change what runs, and every refusal is
// silent (M: no extra runtime warnings).

import type { LocalHistoryProvider, PluginCache } from '@vzn/vx'

/** How long a run waits for the import before it orders without it (M: "wait for download"). */
const IMPORT_DEADLINE_MS = 500
/** Commits walked back from the merge-base (and from HEAD on write) for a blob. */
const WALK = 5
const MAX_BLOB_BYTES = 1024 * 1024
const MAX_TASKS = 50_000
const MAX_MS = 86_400_000

const keyOf = (sha: string): string => `timings\0${sha}`

/**
 * A blob's timings, the entries a run's graph has: `{ version: 1, tasks:
 * { id: ms } }`, each ms a finite number in [0, 24 h]; anything else is
 * dropped. Null for a blob that is not that shape, or over the caps.
 */
export function parseTimings(
  bytes: Uint8Array,
  graph: ReadonlySet<string>,
): Map<string, number> | null {
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
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS && graph.has(id))
      out.set(id, ms)
  }
  return out
}

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

/** The newest blob along `shas`: one probe, one fetch; sequential fetches when the probe has no answer. */
async function newestBlob(cache: PluginCache, shas: readonly string[]): Promise<Uint8Array | null> {
  const held = await cache.has(shas.map(keyOf))
  const present = held === null ? null : new Set(held)
  for (const sha of shas) {
    if (present !== null && !present.has(keyOf(sha))) continue
    const got = await cache.get(keyOf(sha))
    if (got !== null) return got
    if (present !== null) return null
  }
  return null
}

export interface ImportArgs {
  readonly root: string
  readonly defaultBranch: string
  readonly cache: PluginCache
  readonly provider: LocalHistoryProvider
  readonly ids: readonly string[]
}

/**
 * Import the merge-base's timings unless a row already carries that commit;
 * waits at most `IMPORT_DEADLINE_MS`. Resolves true when rows were added.
 * The caller asks only when its forecast read lacked some branch timing.
 */
export async function importTimings(args: ImportArgs): Promise<boolean> {
  let late = false
  const work = (async (): Promise<boolean> => {
    const base = await mergeBase(args.root, args.defaultBranch)
    if (base === null || args.provider.hasImported(base)) return false
    const shas = await lineage(args.root, base)
    if (shas === null) return false
    const blob = await newestBlob(args.cache, shas)
    if (blob === null) return false
    const timings = parseTimings(blob, new Set(args.ids))
    if (timings === null || late) return false
    args.provider.importTimings(base, timings)
    return timings.size > 0
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

export interface ExportArgs {
  readonly root: string
  readonly cache: PluginCache
  readonly provider: LocalHistoryProvider
  readonly ids: readonly string[]
}

/**
 * Write HEAD's blob: each graph task's forecast after the run, which is
 * this run's timing over the parent's imported one. Never replaces a blob.
 */
export async function exportTimings(args: ExportArgs): Promise<void> {
  const head = await git(args.root, ['rev-parse', 'HEAD'])
  if (head?.[0] === undefined) return
  const p50s = await args.provider.p50sFor(args.ids)
  if (p50s.size === 0) return
  const tasks: Record<string, number> = {}
  for (const [id, ms] of [...p50s].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    tasks[id] = Math.round(ms)
  await args.cache.put(
    keyOf(head[0]),
    new TextEncoder().encode(JSON.stringify({ version: 1, tasks })),
  )
}
