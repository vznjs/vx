// Named data sources — the only place a page's data comes from. A page's JSON
// declares `data: { stateKey: 'sourceName' }`; the loader (page.tsx) calls these
// by name and binds the results into `state`. Param-based sources read decoded
// route params. This is infra, written once — never per page.

import {
  type FlakyTask,
  type RunSummaryRow,
  cacheKeyDiff,
  compareRuns,
  explainCacheKey,
  fetchArtifacts,
  fetchHermeticity,
  fetchCatalogProject,
  fetchCatalogProjects,
  fetchCatalogTasks,
  getAnalysis,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getFailures,
  getFlakiest,
  getRegressions,
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
import { type Recommendation, computeRecommendations } from './functions.ts'

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
 * Cross-machine hermeticity (verify-cross-machine §4) for the Insights card:
 * display-ready divergent rows + the derived counts `visible` conditions need
 * as plain state paths. `null` = older serve (no /v1/hermeticity route).
 */
async function hermeticityData(): Promise<Record<string, unknown> | null> {
  const res = await fetchHermeticity(50)
  if (res === null) return null
  return {
    keysTracked: res.keysTracked,
    reportCount: res.reportCount,
    divergentCount: res.divergent.length,
    rows: res.divergent.map((d) => {
      // Reports arrive newest-first from the serve.
      const latest = d.reports[0]
      const platforms = [...new Set(d.reports.map((r) => `${r.os}-${r.arch}`))]
      const shown = d.changed.slice(0, 3).join(', ')
      const more = d.changed.length > 3 ? ` +${d.changed.length - 3} more` : ''
      const partial = d.changedComplete ? '' : ' (partial — a report was truncated)'
      return {
        taskId: d.taskId,
        hash: d.hash,
        platforms: d.crossPlatform
          ? platforms.join(' ⇄ ')
          : 'nondeterministic (same platform)',
        changed:
          d.changed.length > 0 ? `${shown}${more}${partial}` : 'diverged (file list truncated)',
        lastSeen: latest?.at ?? 0,
        _runId: latest?.runId ?? '',
        _runShort: latest?.runId !== undefined ? latest.runId.slice(0, 8) : '',
      }
    }),
  }
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

/**
 * Actionable recommendations for one task (the task-detail Recommendations
 * card): aggregate its flaky / hermeticity / catalog signals into a
 * `{ kind, title, detail, snippet? }` list. Best-effort — each probe degrades
 * to null so a partial serve still yields whatever recommendations it can; a
 * remote/ingest-only serve (no catalog) simply omits the catalog-gated ones.
 */
async function taskRecommendations(p: P): Promise<Recommendation[]> {
  const id = p.id ?? ''
  if (id === '' || !id.includes('#')) return []
  const [project = '', task = ''] = id.split('#', 2)
  const [flakyList, herm, catalogDetail, detail] = await Promise.all([
    getFlakiest(100).catch(() => [] as FlakyTask[]),
    fetchHermeticity(50).catch(() => null),
    project !== '' && task !== '' ? fetchCatalogProject(project).catch(() => null) : Promise.resolve(null),
    getTaskDetail(id).catch(() => null),
  ])
  const flaky = flakyList.find((t) => t.id === id) ?? null
  const divergent = herm?.divergent.find((d) => d.taskId === id) ?? null
  const cfg = catalogDetail?.config as { tasks?: Record<string, unknown> } | undefined
  const taskConfig = (cfg?.tasks?.[task] as Record<string, unknown> | undefined) ?? null
  const avgDurationMs = detail?.aggregate?.avgDurationMs ?? flaky?.p50DurationMs ?? null
  return computeRecommendations({ flaky, divergent, taskConfig, avgDurationMs })
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

/**
 * Period-over-period analysis for the Insights "Trending" card: the raw
 * two-window comparison PLUS the derived per-tile deltas + tones + the mover
 * labels, so the JSON view binds plain state paths (conditions/formatters
 * can't compute a signed tone). `null` = older serve without /v1/analysis.
 */
async function analysisData(): Promise<Record<string, unknown> | null> {
  const cmp = await getAnalysis(7, 3, 8)
  if (cmp === null) return null
  const c = cmp.current.stats
  const p = cmp.previous.stats
  const signed = (n: number): string => (n === 0 ? '±0' : n > 0 ? `+${n}` : `−${Math.abs(n)}`)
  const signedPP = (n: number): string =>
    Math.abs(n) < 0.05 ? '±0.0pp' : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}pp`
  const signedPct = (frac: number): string =>
    Math.abs(frac) < 0.005 ? '±0%' : `${frac > 0 ? '+' : '−'}${Math.round(Math.abs(frac) * 100)}%`
  const failurePP = (c.failureRate - p.failureRate) * 100
  const hitPP = (c.cacheHitRate - p.cacheHitRate) * 100
  const avgDelta = c.avgDurationMs - p.avgDurationMs
  const band = (v: number, dz: number, up: string, down: string): 'good' | 'warn' | 'bad' | 'default' =>
    v > dz ? (up as 'bad' | 'warn') : v < -dz ? (down as 'good') : 'default'
  return {
    windowDays: cmp.windowDays,
    current: c,
    previous: p,
    hasData: c.taskRuns > 0 || p.taskRuns > 0,
    // Per-tile deltas vs the previous equal-length window (data-source derived).
    _runsDelta: signed(c.runs - p.runs),
    _failureLabel: signedPP(failurePP),
    _failureTone: band(failurePP, 0.5, 'bad', 'good'),
    _hitLabel: signedPP(hitPP),
    // A cache-hit-rate DROP is the concern — flip the band direction.
    _hitTone: hitPP > 0.5 ? 'good' : hitPP < -0.5 ? 'warn' : 'default',
    _avgLabel: formatSignedDuration(avgDelta),
    _avgTone: band(avgDelta, 1, 'warn', 'good'),
    movers: cmp.movers.map((m) => ({
      ...m,
      _deltaLabel: formatSignedDuration(m.deltaMs),
      _pctLabel: signedPct(m.deltaPct),
      // 'slower'/'faster' drives the red/green delta dot (DotMap 'delta').
      _dir: m.deltaMs > 0 ? 'slower' : m.deltaMs < 0 ? 'faster' : 'same',
    })),
  }
}

/**
 * Regressions for the Insights "Started failing" card: tasks now failing across
 * branches that used to pass. Adds a joined branch string + a kind label so the
 * DataTable binds plain fields. `null` = older serve without /v1/regressions.
 */
async function regressionRows(): Promise<Record<string, unknown>[] | null> {
  const rows = await getRegressions(14, 2, 25)
  if (rows === null) return null
  return rows.map((r) => ({
    ...r,
    _branchList: r.branches.join(', '),
    _kind: r.regressed ? 'regressed' : 'always-broken',
  }))
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
  analysis: () => analysisData(),
  regressions: () => regressionRows(),
  prunable: () => getPrunable(7, 25),
  serverMeta: () => getMeta(),
  // Workspace catalog (colocated serves only) — null on a remote/older serve,
  // so catalog-backed cards gate on `<key>Status` and simply hide elsewhere.
  catalog: () => workspaceCatalog(),
  catalogTasks: () => fetchCatalogTasks().catch(() => null),
  artifacts: () => artifactRows(),
  hermeticity: () => hermeticityData(),
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
  taskRecommendations: (p) => taskRecommendations(p),
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
