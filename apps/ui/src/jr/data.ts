// Named data sources — the only place a page's data comes from. A page's JSON
// declares `data: { stateKey: 'sourceName' }`; the loader (page.tsx) calls these
// by name and binds the results into `state`. Param-based sources read decoded
// route params. This is infra, written once — never per page.

import {
  compareRuns,
  explainCacheKey,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getFailures,
  getFlakiest,
  getHeatmap,
  getHistory,
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
  whyDidThisRerun,
} from '../api.ts'

type P = Record<string, string>

/** Display-ready row for the run-detail "Why did this re-run?" table. */
interface WhyRow {
  taskId: string
  project: string
  task: string
  hashChanged: boolean | null
  previousHash: string | null
  currentHash: string | null
  reason: string
}

/** Human reason from the hash-changed signal (no full input-file diff yet). */
function whyReason(hashChanged: boolean | null, hadPrevious: boolean): string {
  if (!hadPrevious) return 'first run'
  if (hashChanged) return 'inputs changed'
  return 'same key (forced / unrelated)'
}

/**
 * For each task in a run, fetch /v1/why and flatten to a display row. Fetches
 * are batched concurrently; a failed per-task probe degrades to an unknown row
 * rather than failing the whole section.
 */
async function runWhy(runId: string): Promise<WhyRow[]> {
  const run = await getRun(runId)
  if (!run) return []
  return await Promise.all(
    run.tasks.map(async (t): Promise<WhyRow> => {
      const taskId = `${t.project}#${t.task}`
      try {
        const w = await whyDidThisRerun(runId, taskId)
        const hadPrevious = w.previousRun != null
        return {
          taskId,
          project: t.project,
          task: t.task,
          hashChanged: w.hashChanged ?? null,
          previousHash: w.previousRun?.hash ?? null,
          currentHash: w.thisRun?.hash ?? t.hash ?? null,
          reason: whyReason(w.hashChanged ?? null, hadPrevious),
        }
      } catch {
        return {
          taskId,
          project: t.project,
          task: t.task,
          hashChanged: null,
          previousHash: null,
          currentHash: t.hash ?? null,
          reason: 'unavailable',
        }
      }
    }),
  )
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

function signedDuration(ms: number): string {
  const sign = ms > 0 ? '+' : '−'
  const abs = Math.abs(ms)
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}s` : `${Math.round(abs)}ms`
  return `${sign}${body}`
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
      deltaLabel = signedDuration(t.durationDeltaMs)
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
  cacheKey: (p) => explainCacheKey(p.id ?? ''),
  run: (p) => getRun(p.id ?? ''),
  runWhy: (p) => runWhy(p.id ?? ''),
  compare: (p) => compareRuns(p.id ?? ''),
  compareRows: (p) => compareRows(p.id ?? ''),
  projectTasks: (p) => getHistory({ limit: 500 }).then((h) => h.filter((t) => t.project === p.name)),
  projectSummary: (p) => listProjects(500).then((ps) => ps.find((x) => x.project === p.name) ?? null),
}
