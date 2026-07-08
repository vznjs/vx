// Named data sources — the only place a page's data comes from. A page's JSON
// declares `data: { stateKey: 'sourceName' }`; the loader (page.tsx) calls these
// by name and binds the results into `state`. Param-based sources read decoded
// route params. This is infra, written once — never per page.

import {
  type RunSummaryRow,
  cacheKeyDiff,
  compareRuns,
  explainCacheKey,
  fetchArtifacts,
  fetchCatalogProject,
  fetchCatalogProjects,
  fetchCatalogTasks,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getFailures,
  getFlakiest,
  getHeatmap,
  getHistory,
  getInvocation,
  getMeta,
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
  listRuns,
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

/**
 * Display-ready row for the /artifacts table — the nested provenance join
 * flattened into the flat keys DataTable columns read. `_taskId`/`_runId`
 * stay '' when the serve never ingested the producing run, so link columns
 * degrade to '—'.
 */
async function artifactRows(): Promise<Record<string, unknown>[] | null> {
  const list = await fetchArtifacts(200)
  if (list === null) return null // older serve — no /v1/artifacts route
  return list.map((a) => ({
    ...a,
    _project: a.task?.project ?? '',
    _task: a.task?.task ?? '',
    _taskId: a.task ? `${a.task.project}#${a.task.task}` : '',
    _runId: a.task?.runId ?? '',
    _runShort: a.task?.runId !== undefined ? a.task.runId.slice(0, 8) : '',
  }))
}

/**
 * The workspace catalog for the Workspace page, with the two derived counts
 * `visible` conditions need as plain state paths (conditions can't compute):
 * `_taskTotal` and `_staleCount`. `null` = remote/older serve (no catalog).
 */
async function workspaceCatalog(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchCatalogProjects()
    return {
      ...r,
      _taskTotal: r.projects.reduce((acc, p) => acc + p.taskCount, 0),
      _staleCount: r.staleProjects?.length ?? 0,
    }
  } catch {
    return null
  }
}

/** Runs that produced/hit one cache entry — /v1/runs filtered by hash. */
async function cacheEntryRuns(hash: string): Promise<Record<string, unknown>[]> {
  const runs = await listRuns({ limit: 1000 })
  return runs
    .filter((r): r is RunSummaryRow & { runId: string } => r.hash === hash && r.runId !== null)
    .map((r) => ({ ...r, _taskRef: `${r.project}#${r.task}` }))
}

/**
 * The `?task=` deep-link seed for run detail's selected-task card: resolve
 * the query param to the run's matching task row (falls back to a bare
 * {project, task} so the card + TaskLogs still work when the row is gone).
 * `null` when the link carries no task — the card stays closed.
 */
async function runSelectedTask(p: P): Promise<unknown> {
  const ref = p.task
  if (ref === undefined || ref === '' || !ref.includes('#')) return null
  const [project = '', task = ''] = ref.split('#', 2)
  const run = await getRun(p.id ?? '').catch(() => null)
  return run?.tasks.find((t) => t.project === project && t.task === task) ?? { project, task }
}

export const SOURCES: Record<string, (p: P) => Promise<unknown>> = {
  cacheStats: () => getCacheStats(),
  cacheSavings: () => getCacheSavings(),
  topTasks: () => getTopTasks(8),
  failures: () => getFailures(8),
  projects: () => listProjects(50),
  projectsAll: () => listProjects(500),
  invocations: () => listInvocations(12),
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
  serverMeta: () => getMeta(),
  // Workspace catalog (colocated serves only) — null on a remote/older serve,
  // so catalog-backed cards gate on `<key>Status` and simply hide elsewhere.
  catalog: () => workspaceCatalog(),
  catalogTasks: () => fetchCatalogTasks().catch(() => null),
  artifacts: () => artifactRows(),
  // param-based (route params + query params, already decoded by the loader)
  taskDetail: (p) => getTaskDetail(p.id ?? ''),
  cacheKey: (p) => explainCacheKey(p.id ?? ''),
  // The flaky badge: non-null only when /v1/flakiness flags this task.
  taskFlaky: (p) => getFlakiest(100).then((ts) => ts.find((t) => t.id === p.id) ?? null),
  catalogTask: async (p) => {
    const [project = '', task = ''] = (p.id ?? '').split('#', 2)
    if (project === '' || task === '') return null
    const detail = await fetchCatalogProject(project).catch(() => null)
    const config = (detail?.config as { tasks?: Record<string, unknown> } | undefined)?.tasks?.[task]
    if (config === undefined || detail === null) return null
    return { config, source: detail.source, stale: detail.stale === true }
  },
  catalogProject: (p) => fetchCatalogProject(p.name ?? '').catch(() => null),
  run: (p) => getRun(p.id ?? ''),
  runWhy: (p) => runWhy(p.id ?? ''),
  runSelectedTask: (p) => runSelectedTask(p),
  invocationDetail: (p) => getInvocation(p.id ?? ''),
  compare: (p) => compareRuns(p.id ?? ''),
  compareRows: (p) => compareRows(p.id ?? ''),
  projectTasks: (p) => getHistory({ limit: 500 }).then((h) => h.filter((t) => t.project === p.name)),
  projectSummary: (p) => listProjects(500).then((ps) => ps.find((x) => x.project === p.name) ?? null),
  cacheEntry: (p) =>
    listCacheEntries({ limit: 500 }).then((es) => es.find((e) => e.hash === p.hash) ?? null),
  cacheEntryRuns: (p) => cacheEntryRuns(p.hash ?? ''),
}
