// Named data sources — the only place a page's data comes from. A page's JSON
// declares `data: { stateKey: 'sourceName' }`; the loader (page.tsx) calls these
// by name and binds the results into `state`. Param-based sources read decoded
// route params. This is infra, written once — never per page.

import {
  cacheKeyDiff,
  compareRuns,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getFailures,
  getFlakiest,
  getHeatmap,
  getHistory,
  getInvocation,
  getParallelismHistory,
  getPrunable,
  getRun,
  getRunTrends,
  getStorageGrowth,
  getTaskDetail,
  getTopTasks,
  listCacheEntries,
  listInvocations,
  listProjects,
} from '../api.ts'
import { formatSignedDuration } from '../format.ts'

type P = Record<string, string>

/** Run `fn` over `items` with at most `limit` in flight (browser fan-out cap). */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

/**
 * Display-ready row for the run-detail "Why did this re-run?" table. One row per
 * changed cache-key component across all of the run's tasks — the input-
 * fingerprint moat. B5's runDetail view binds to these exact fields.
 */
interface WhyRow {
  taskId: string
  project: string
  task: string
  /** Why this task RE-RAN: 'inputs changed' | 'first run' | 'not cacheable / forced'. */
  reason: string
  /** Component kind (only for 'inputs changed' rows): file | env | runtime | … ; '' otherwise. */
  kind: string
  /** Component name (file path, env var, …); '' for non-component reason rows. */
  name: string
  change: 'added' | 'removed' | 'changed' | ''
  /** The component's hash in the previous run (null when `added` or not applicable). */
  before: string | null
  /** The component's hash in this run (null when `removed` or not applicable). */
  after: string | null
}

/**
 * For each task in a run, fetch /v1/diff and flatten its changed components into
 * display rows — one row per changed/added/removed cache-key component across
 * all the run's tasks. Tasks whose diff has no entries are skipped. Fetches are
 * batched concurrently; a failed per-task probe degrades to no rows rather than
 * failing the whole section.
 */
async function runWhy(runId: string): Promise<WhyRow[]> {
  const run = await getRun(runId)
  if (!run) return []
  // Bounded fan-out: a 500-task re-run must not fire 500 parallel requests.
  const perTask = await mapPool(run.tasks, 8, async (t): Promise<WhyRow[]> => {
      // Only tasks that actually RE-RAN belong in a "why did this re-run"
      // panel. Cache hits (cache-hit / cache-hit-remote) and skips did not
      // re-run, so they're excluded — listing them was the "everything shows
      // up" bug.
      if (t.status !== 'success' && t.status !== 'failed') return []
      const taskId = `${t.project}#${t.task}`
      const base = { taskId, project: t.project, task: t.task }
      let diff
      try {
        diff = await cacheKeyDiff(runId, taskId)
      } catch {
        return [{ ...base, reason: 'ran', kind: '', name: '', change: '', before: null, after: null }]
      }
      if (!diff.found || diff.previousRunId === null) {
        // No prior run of this task to diff against.
        return [{ ...base, reason: 'first run', kind: '', name: '', change: '', before: null, after: null }]
      }
      if (diff.entries.length > 0) {
        // The cache key changed — one row per changed input component.
        return diff.entries.map(
          (e): WhyRow => ({ ...base, reason: 'inputs changed', kind: e.kind, name: e.name, change: e.change, before: e.before, after: e.after }),
        )
      }
      // Ran with the SAME key as the previous run: the task isn't cached
      // (no `cache:` config / outputs) or caching was bypassed (--force /
      // --no-cache). Honest, single reason row.
      return [{ ...base, reason: 'not cacheable / forced', kind: '', name: '', change: '', before: null, after: null }]
  })
  return perTask.flat()
}

/** Display row for the run-comparison table — flattened, signed deltas. */
interface CompareRow {
  taskId: string
  project: string
  task: string
  aStatus: string | null
  aCacheHit: boolean | null
  aDurationMs: number | null
  bStatus: string | null
  bCacheHit: boolean | null
  bDurationMs: number | null
  deltaLabel: string
  deltaKind: 'slower' | 'faster' | 'same' | 'new' | 'gone'
  keyChanged: 'changed' | 'same'
}

/** Fetch /v1/compare and flatten each task into a display row. */
async function compareRows(runId: string): Promise<CompareRow[]> {
  const cmp = await compareRuns(runId)
  return cmp.tasks.map((t): CompareRow => {
    let deltaKind: CompareRow['deltaKind']
    let deltaLabel: string
    if (t.a === null) {
      deltaKind = 'gone'
      deltaLabel = 'only in prev'
    } else if (t.b === null) {
      deltaKind = 'new'
      deltaLabel = 'new'
    } else if (t.durationDeltaMs === null || t.durationDeltaMs === 0) {
      deltaKind = 'same'
      deltaLabel = '±0'
    } else {
      deltaKind = t.durationDeltaMs > 0 ? 'slower' : 'faster'
      deltaLabel = formatSignedDuration(t.durationDeltaMs)
    }
    return {
      taskId: t.taskId,
      project: t.project,
      task: t.task,
      aStatus: t.a?.status ?? null,
      aCacheHit: t.a?.cacheHit ?? null,
      aDurationMs: t.a?.durationMs ?? null,
      bStatus: t.b?.status ?? null,
      bCacheHit: t.b?.cacheHit ?? null,
      bDurationMs: t.b?.durationMs ?? null,
      deltaLabel,
      deltaKind,
      keyChanged: t.hashChanged ? 'changed' : 'same',
    }
  })
}

export const SOURCES: Record<string, (p: P) => Promise<unknown>> = {
  cacheStats: () => getCacheStats(),
  cacheSavings: () => getCacheSavings(),
  topTasks: () => getTopTasks(8),
  failures: () => getFailures(8),
  projects: () => listProjects(50),
  projectsAll: () => listProjects(500),
  invocations: () => listInvocations(12),
  invocationsAll: () => listInvocations(200),
  trends: () => getRunTrends({ bucket: 'day' }).then((r) => r.points),
  history: () => getHistory({ limit: 500 }),
  cacheBreakdown: () => getCacheBreakdown(100),
  storage: () => getStorageGrowth(30),
  cacheEntries: () => listCacheEntries({ limit: 200, orderBy: 'size_bytes' }),
  heatmap: () => getHeatmap(30),
  parallelism: () => getParallelismHistory(50),
  bottlenecks: () => getBottlenecks(14, 25),
  flaky: () => getFlakiest(25),
  prunable: () => getPrunable(7, 25),
  // param-based (route params, already decoded by the loader)
  taskDetail: (p) => getTaskDetail(p.id ?? ''),
  run: (p) => getRun(p.id ?? ''),
  runWhy: (p) => runWhy(p.id ?? ''),
  invocationDetail: (p) => getInvocation(p.id ?? ''),
  compare: (p) => compareRuns(p.id ?? ''),
  compareRows: (p) => compareRows(p.id ?? ''),
  projectTasks: (p) => getHistory({ limit: 500 }).then((h) => h.filter((t) => t.project === p.name)),
  projectSummary: (p) => listProjects(500).then((ps) => ps.find((x) => x.project === p.name) ?? null),
}
