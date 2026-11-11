// What a real-repo run leaves behind: turbo-repo.sh / nx-repo.sh print one
// line per timed arm, and real-repos.json holds one row per repo, each
// figure the best successful rep of vx and of the repo's own tool.

export const ARMS = ['cold', 'restore', 'noop'] as const
export type Arm = (typeof ARMS)[number]

/** One row of real-repos.json. Figures are [vx, theirs]; `**` marks theirs when it wins. */
export interface DataRow {
  repo: string
  tool: 'Turbo' | 'Nx'
  version: string
  /** The revision the run checked out; the `turbo()` / `nx()` rows name theirs in `heading`. */
  commit?: string
  /** `linux x64, 4 cores`: where the native rows ran. */
  machine?: string
  /** The box's 1-, 5- and 15-minute load when the arms began (`settle`). */
  load?: string
  setup: string
  date: string
  heading: string
  cold: [string, string]
  restore: [string, string]
  noop: [string, string]
  why?: string
}

export interface Best {
  /** `<tool> <arm>` → the fastest successful rep, in ms. */
  ms: Map<string, number>
  /** `<tool> <arm> exited <code>`, one per failed rep. */
  failed: string[]
}

/** The best successful rep per tool and arm, from `<tool> <arm> <ms> ms exit=<code>` lines. */
export function bestReps(out: string): Best {
  const ms = new Map<string, number>()
  const failed: string[] = []
  for (const m of out.matchAll(/^(\w+) (\w+) (\d+) ms exit=(\d+)$/gm)) {
    const [, tool, arm, t, code] = m
    if (code !== '0') {
      failed.push(`${tool} ${arm} exited ${code}`)
      continue
    }
    const k = `${tool} ${arm}`
    ms.set(k, Math.min(ms.get(k) ?? Infinity, Number(t)))
  }
  return { ms, failed }
}

/** The 1-minute load the arms wait under, and for how long at most. */
const QUIET_LOAD = 1
export const SETTLE_MS = 120_000

/**
 * Wait until the 1-minute load drops under {@link QUIET_LOAD}, at most
 * {@link SETTLE_MS}, and say the load the arms then start at. A
 * workspace run right after another's cold builds began at a load of 14,
 * and its restore lost a tie by one lucky rival rep (2026-11-11).
 */
export async function settle(
  loadavg: () => number[],
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<string> {
  const until = now() + SETTLE_MS
  while (loadavg()[0]! >= QUIET_LOAD && now() < until) await sleep(5_000)
  return loadavg()
    .map((l) => l.toFixed(2))
    .join(' ')
}

/** real-repos.json's spelling: `66 ms`, `3.44 s`, `40.6 s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/**
 * The row for one repo, or the arms either tool has no successful rep
 * of. `rival` is the harness's tool name (`turbo`, `nx`).
 */
export function dataRow(
  meta: Omit<DataRow, Arm | 'tool'>,
  rival: 'turbo' | 'nx',
  best: Best,
): { row: DataRow } | { missing: string[] } {
  const missing: string[] = []
  const cells = {} as Record<Arm, [string, string]>
  for (const arm of ARMS) {
    const vx = best.ms.get(`vx ${arm}`)
    const theirs = best.ms.get(`${rival} ${arm}`)
    if (vx === undefined) missing.push(`vx ${arm}`)
    if (theirs === undefined) missing.push(`${rival} ${arm}`)
    if (vx === undefined || theirs === undefined) continue
    cells[arm] = [formatMs(vx), theirs < vx ? `**${formatMs(theirs)}**` : formatMs(theirs)]
  }
  if (missing.length > 0) return { missing }
  const { repo, ...rest } = meta
  return { row: { repo, tool: rival === 'nx' ? 'Nx' : 'Turbo', ...rest, ...cells } }
}

/** `rows` with each fresh row in place of the one for its repo; a new repo is appended. */
export function mergeRows(rows: readonly DataRow[], fresh: readonly DataRow[]): DataRow[] {
  const byRepo = new Map(fresh.map((r) => [r.repo, r]))
  const merged = rows.map((r) => byRepo.get(r.repo) ?? r)
  const kept = new Set(rows.map((r) => r.repo))
  return [...merged, ...fresh.filter((r) => !kept.has(r.repo))]
}

/** The file as oxfmt leaves it: each figure pair on one line. */
export function serializeData(data: { rows: readonly DataRow[] }): string {
  const pair = /\[\n\s+("(?:[^"\\]|\\.)*"),\n\s+("(?:[^"\\]|\\.)*")\n\s+\]/g
  return `${JSON.stringify(data, null, 2).replace(pair, '[$1, $2]')}\n`
}
