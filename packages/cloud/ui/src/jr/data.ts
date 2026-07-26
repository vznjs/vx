// Named data sources — the only place a page's data comes from. A page's JSON
// declares `data: { stateKey: 'sourceName' }`; the loader (page.tsx) calls these
// by name and binds the results into `state`. Param-based sources read decoded
// route params. This is infra, written once — never per page.

import {
  type FlakyTask,
  type ProjectRankRow as ApiProjectRankRow,
  type PeriodComparison,
  type ProjectRollup,
  type RunSummaryRow,
  type TaskDetail,
  type TaskHistoryRow,
  type TaskMover,
  compareRuns,
  explainCacheKey,
  fetchRunTriage,
  fetchRunWhy,
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
  getFlakeTrend,
  getFlakiest,
  getTaskFlaky,
  getLeastStable,
  getTaskStability,
  getProject,
  getProjectBranchFailures,
  getProjectRank,
  getProjectTaskTrends,
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
  listProjects,
  listProjectsPage,
  listRuns,
} from '../api.ts'
import { formatDate, formatRelativeTime, formatSignedDuration } from '../format.ts'
import {
  type Recommendation,
  computeRecommendations,
  detectSlowdowns,
  foldFlakeTrend,
} from './functions.ts'

type P = Record<string, string>


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
  /** Numeric delta + the A-side magnitude it is relative to — the diverging
   *  bar needs a number, and the flat band needs something to be flat AGAINST. */
  deltaMs: number
  baseMs: number
  deltaKind: 'slower' | 'faster' | 'same' | 'new' | 'gone'
  keyChanged: 'changed' | 'same'
  _sameKey: boolean
  _noiseMs: number | undefined
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
      // NaN when a side is missing: 'new'/'only in prev' is not a zero delta.
      deltaMs: t.a === null || t.b === null ? Number.NaN : (t.durationDeltaMs ?? 0),
      baseMs: t.a?.durationMs ?? 0,
      deltaKind,
      keyChanged: t.hashChanged ? 'changed' : 'same',
      // Same key ⇒ identical inputs ⇒ the delta is this task's measurement
      // noise. The table renders magnitude but passes no verdict on it.
      _sameKey: !t.hashChanged,
      // The task's OWN measured noise floor: a cross-key delta smaller than
      // this is inside the margin of error, so the table must not call it a
      // change. Absent (undefined) ⇒ the cell falls back to its heuristic.
      _noiseMs:
        t.noiseCv !== undefined && t.a !== null
          ? Math.round(t.noiseCv * t.a.durationMs)
          : undefined,
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
    project !== '' && task !== ''
      ? getTaskFlaky(project, task).catch(() => null)
      : Promise.resolve(null),
    fetchHermeticity(50).catch(() => null),
    project !== '' && task !== '' ? fetchCatalogProject(project).catch(() => null) : Promise.resolve(null),
    getTaskDetail(id).catch(() => null),
  ])
  const flaky = flakyList
  const divergent = herm?.divergent.find((d) => d.taskId === id) ?? null
  const cfg = catalogDetail?.config as { tasks?: Record<string, unknown> } | undefined
  const taskConfig = (cfg?.tasks?.[task] as Record<string, unknown> | undefined) ?? null
  const avgDurationMs = detail?.aggregate?.avgDurationMs ?? flaky?.p50DurationMs ?? null
  return computeRecommendations({ flaky, divergent, taskConfig, avgDurationMs })
}

/** Runs that produced/hit one cache entry — /v1/runs filtered by hash. */
async function cacheEntryRuns(hash: string): Promise<Record<string, unknown>[]> {
  // Filtered SERVER-side: pulling 1000 runs and matching in the client missed
  // every older run the moment a workspace outgrew that page.
  const runs = await listRuns({ hash, limit: 200 })
  return runs
    .filter((r): r is RunSummaryRow & { runId: string } => r.runId !== null)
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

const signed = (n: number): string => (n === 0 ? '±0' : n > 0 ? `+${n}` : `−${Math.abs(n)}`)
const signedPP = (n: number): string =>
  Math.abs(n) < 0.05 ? '±0.0pp' : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}pp`
const signedPct = (frac: number): string =>
  Math.abs(frac) < 0.005 ? '±0%' : `${frac > 0 ? '+' : '−'}${Math.round(Math.abs(frac) * 100)}%`
const band = (v: number, dz: number, up: string, down: string): 'good' | 'warn' | 'bad' | 'default' =>
  v > dz ? (up as 'bad' | 'warn') : v < -dz ? (down as 'good') : 'default'

/**
 * The two-window trend, flattened for pure-JSON binding: raw window stats PLUS
 * signed per-tile deltas + direction tones (conditions/formatters can't
 * compute a signed tone). Shared by the workspace-wide Insights card and the
 * per-task / per-project entity trends — the single-dev "did MY performance
 * improve or decrease?" read.
 */
function trendFields(cmp: PeriodComparison): Record<string, unknown> {
  const c = cmp.current.stats
  const p = cmp.previous.stats
  const failurePP = (c.failureRate - p.failureRate) * 100
  const hitPP = (c.cacheHitRate - p.cacheHitRate) * 100
  const avgDelta = c.avgDurationMs - p.avgDurationMs
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
  }
}

/**
 * Period-over-period analysis for the Insights "Trending" card: the shared
 * trend fields plus the workspace-wide movers table. `null` = older serve
 * without /v1/analysis.
 */
async function analysisData(windowDays = 7): Promise<Record<string, unknown> | null> {
  const cmp = await getAnalysis(windowDays, 3, 8)
  if (cmp === null) return null
  return {
    ...trendFields(cmp),
    movers: cmp.movers.map((m) => ({
      ...m,
      _deltaLabel: formatSignedDuration(m.deltaMs),
      _pctLabel: signedPct(m.deltaPct),
      // 'slower'/'faster' drives the red/green delta dot (DotMap 'delta').
      _dir: m.deltaMs > 0 ? 'slower' : m.deltaMs < 0 ? 'faster' : 'same',
    })),
  }
}

/** The per-entity trend (task or project scope). `windowDays` lets a page with
 *  the timeframe selector rescope it; defaults to 7 so pages without the
 *  selector stay byte-identical. `null` = older serve. */
async function scopedTrend(
  scope: { project?: string; task?: string },
  windowDays = 7,
): Promise<Record<string, unknown> | null> {
  const cmp = await getAnalysis(windowDays, 1, 1, scope)
  if (cmp === null) return null
  return trendFields(cmp)
}

/**
 * Shape the server's true per-axis ranks for the RankList card. The ranking is
 * computed over EVERY project in SQL (window functions), so `_rankLabel` and
 * the "vs N projects" total are the truth at any workspace size — the previous
 * client-side ranker ranked within a 500-row page and mis-stated both.
 */
function rankAxes(res: {
  total: number
  byFailRate: ApiProjectRankRow[]
  byAvg: ApiProjectRankRow[]
  byHitRate: ApiProjectRankRow[]
}): {
  byFailRate: Record<string, unknown>[]
  byAvg: Record<string, unknown>[]
  byHitRate: Record<string, unknown>[]
  total: number
} {
  const axis = (rows: ApiProjectRankRow[]): Record<string, unknown>[] =>
    rows.map((r) => ({
      project: r.project,
      _me: r.me,
      _rank: r.rank,
      _rankLabel: `#${r.rank}`,
      _value: r.value,
    }))
  return {
    byFailRate: axis(res.byFailRate),
    byAvg: axis(res.byAvg),
    byHitRate: axis(res.byHitRate),
    total: res.total,
  }
}

/**
 * The project's lifetime per-task aggregates ENRICHED with each task's Δavg vs
 * the prior window (from the period-comparison movers) — the "did MY tasks get
 * slower?" column. A task with no mover entry (too few runs in a window) gets a
 * neutral dot and no Δ label. `movers` may be null on an older serve.
 */
function mergeMoverDelta(
  history: TaskHistoryRow[],
  movers: TaskMover[] | undefined,
): Record<string, unknown>[] {
  const byId = new Map((movers ?? []).map((m) => [m.id, m]))
  return history.map((t) => {
    const m = byId.get(t.id)
    return {
      ...t,
      _deltaLabel: m === undefined ? '—' : formatSignedDuration(m.deltaMs),
      // 'slower'/'faster'/'same' → the red/green/neutral 'delta' DotMap.
      _deltaDir:
        m === undefined ? 'same' : m.deltaMs > 0 ? 'slower' : m.deltaMs < 0 ? 'faster' : 'same',
    }
  })
}

/**
 * Group the flat per-(task, bucket) trend rows into one item per task carrying
 * its avg-duration `series` (number[], time-ordered), latest value, total
 * failures, and a trend token (up/down/flat over the window) — the shape the
 * SparkList binds. "Spot per-task outliers/spikes/trends" at a glance. `null` =
 * older serve without /v1/trends/tasks.
 */
export function foldTaskTrendPoints(
  project: string,
  points: { task: string; t: number; avgDurationMs: number; failures: number }[],
): Record<string, unknown>[] {
  const byTask = new Map<string, { t: number; avg: number; failures: number }[]>()
  for (const p of points) {
    const arr = byTask.get(p.task) ?? []
    arr.push({ t: p.t, avg: p.avgDurationMs, failures: p.failures })
    byTask.set(p.task, arr)
  }
  const items = [...byTask.entries()].map(([task, cells]) => {
    cells.sort((a, b) => a.t - b.t)
    // avg 0 is the server's "no executed success in this bucket" sentinel
    // (all-hit or all-failed) — plotting it would draw a to-zero dip that
    // reads as "got fast", and a trailing sentinel would report a 0ms latest.
    // The sparkline is the EXECUTED-duration series; failures surface via the
    // trend dot, hits aren't durations at all.
    const series = cells.map((c) => c.avg).filter((v) => v > 0)
    const failures = cells.reduce((s, c) => s + c.failures, 0)
    const latest = series.length > 0 ? series[series.length - 1]! : 0
    const first = series[0] ?? 0
    const last = latest
    // Trend over the window (duration): up = slower (bad), down = faster (good).
    const trend = first === 0 || last === 0 || series.length < 2 ? 'flat' : last > first * 1.1 ? 'up' : last < first * 0.9 ? 'down' : 'flat'
    return {
      task,
      _taskRef: `${project}#${task}`,
      series,
      _latest: latest,
      _failures: failures,
      _trend: trend,
      // For the delta dot: slower/faster/same mirror up/down/flat.
      _dir: trend === 'up' ? 'slower' : trend === 'down' ? 'faster' : 'same',
    }
  })
  // Slowest-latest on top — the task most worth a look.
  return items.sort((a, b) => (b._latest as number) - (a._latest as number))
}

async function projectTaskTrendItems(
  project: string,
  args: { bucket: 'hour' | 'day'; from: number; to: number },
): Promise<Record<string, unknown>[] | null> {
  const points = await getProjectTaskTrends(project, { ...args, limit: 20 })
  if (points === null) return null
  return foldTaskTrendPoints(project, points)
}

/**
 * Per-task branch-first-failure rows for the project view ("where was the issue
 * first noticed"). Adds a joined branch string + an urgency dot. `null` = older
 * serve without /v1/branch-failures.
 */
async function branchFailureRows(
  project: string,
  sinceDays: number,
): Promise<Record<string, unknown>[] | null> {
  const rows = await getProjectBranchFailures(project, sinceDays, 50)
  if (rows === null) return null
  return rows.map((r) => ({
    ...r,
    _taskRef: `${project}#${r.task}`,
    _branchList: r.branches.map((b) => b.branch).join(', '),
    // A first-noticed failure is a live break → red 'delta' dot.
    _dir: 'slower',
  }))
}

/**
 * One-click debug jumps for the task-detail Debug card (single-dev lens: from
 * a broken task straight to its evidence). `runs` rows deep-link the run with
 * this task pre-selected (logs open); `artifact` rows land on the cache-entry
 * page (facts + download). Split because the two row kinds link to different
 * routes and RankList takes one href template.
 */
function taskDebugRows(detail: TaskDetail): {
  runs: Record<string, unknown>[]
  artifact: Record<string, unknown>[]
} {
  const ref = `${detail.project}#${detail.task}`
  const runs: Record<string, unknown>[] = []
  const lastFailed = detail.recent.find((r) => r.status === 'failed' && r.runId !== null)
  if (lastFailed !== undefined) {
    runs.push({
      label: 'Last failed run — logs open on this task',
      at: lastFailed.startedAt,
      _runId: lastFailed.runId,
      _taskRef: ref,
    })
  }
  const latest = detail.recent.find((r) => r.runId !== null)
  // Skip the duplicate row when the latest run IS the last failed one.
  if (latest !== undefined && latest.runId !== lastFailed?.runId) {
    runs.push({ label: 'Latest run', at: latest.startedAt, _runId: latest.runId, _taskRef: ref })
  }
  const artifact: Record<string, unknown>[] = []
  if (detail.latestEntry !== null) {
    artifact.push({
      label: 'Latest artifact — cache entry + download',
      at: detail.latestEntry.createdAt,
      _hash: detail.latestEntry.hash,
    })
  }
  return { runs, artifact }
}

/**
 * Regressions for the Insights "Started failing" card: tasks now failing across
 * branches that used to pass. Adds a joined branch string + a kind label so the
 * DataTable binds plain fields. `null` = older serve without /v1/regressions.
 */
async function regressionRows(sinceDays = 14): Promise<Record<string, unknown>[] | null> {
  const rows = await getRegressions(sinceDays, 2, 25)
  if (rows === null) return null
  return rows.map((r) => ({
    ...r,
    _branchList: r.branches.join(', '),
    _kind: r.regressed ? 'regressed' : 'always-broken',
    // Drives the status dot via the 'delta' DotMap: a regression (used to
    // pass) is urgent → 'slower' → red; an always-broken task → 'gone' → amber.
    _dirReg: r.regressed ? 'slower' : 'gone',
  }))
}

// Insights timeframe selector: the `?window` token → days. When absent, each
// source uses its OWN fallback, so pages without the selector (Cache, Overview,
// deep-links) keep their existing windows byte-identically.
const WINDOW_DAYS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
export function windowDaysOf(p: P, fallback: number): number {
  const w = p.window
  return w !== undefined && w in WINDOW_DAYS ? WINDOW_DAYS[w]! : fallback
}
/** How many rows a list source asks for. The server clamps to this too, so a
 *  full page means "there are more" rather than "that's the workspace". */
export const LIST_PAGE = 500
/**
 * The `?q` the Projects/Tasks filter box writes (debounced by DataTable). It
 * rides the SAME loader params `?window` does, so a keystroke re-keys the
 * page's sources and the SERVER narrows — which is the only way the box can
 * reach a row past the page on a 1000-project / 10k-task workspace.
 */
export function searchOf(p: P): string {
  return (p.q ?? '').trim()
}

/**
 * The Projects table's truncation notice. Two different truths: with no search
 * the workspace total is the denominator ("N of M"); WITH one the server
 * answered a match set, so the total is not its denominator and a full page is
 * the only honest signal that matches were left out.
 */
export function pageNote(
  search: string,
  shown: number,
  total: number,
): { _truncated: boolean; _note: string } {
  if (search !== '') {
    return {
      _truncated: shown >= LIST_PAGE,
      _note: `showing the first ${shown} matches for “${search}” — refine the search to narrow it`,
    }
  }
  return {
    _truncated: total > shown,
    _note: `showing ${shown} of ${total} projects — the filter box searches all of them`,
  }
}

/** Trends respect the timeframe: a 24h window is hourly over the last day;
 *  anything longer is daily over that span. */
export function trendArgsOf(p: P): { bucket: 'hour' | 'day'; from: number; to: number } {
  const days = windowDaysOf(p, 30)
  const to = Date.now()
  const bucket = days <= 1 ? 'hour' : 'day'
  return { bucket, from: to - days * 24 * 60 * 60 * 1000, to }
}

export const SOURCES: Record<string, (p: P) => Promise<unknown>> = {
  cacheStats: (p) => getCacheStats(windowDaysOf(p, 1)),
  cacheSavings: () => getCacheSavings(),
  topTasks: () => getTopTasks(8),
  failures: () => getFailures(8),
  // The page PLUS the workspace's true size. A 1000-project workspace must
  // say so rather than silently presenting 500 rows as the whole truth.
  projectsAll: async (p) => {
    const search = searchOf(p)
    const { projects, total } = await listProjectsPage({
      limit: LIST_PAGE,
      ...(search !== '' ? { search } : {}),
    })
    return {
      rows: projects,
      total,
      shown: projects.length,
      ...pageNote(search, projects.length, total),
    }
  },
  trends: (p) => getRunTrends(trendArgsOf(p)).then((r) => r.points),
  history: (p) => {
    const search = searchOf(p)
    return getHistory({ limit: LIST_PAGE, ...(search !== '' ? { search } : {}) })
  },
  // "Got slower" (dev-scenarios S5): each task's LATEST executed run vs its
  // own p50 — composed client-side from two reads the hub already knows.
  slowdowns: async () => {
    const [hist, rows] = await Promise.all([
      getHistory({ limit: 500 }).catch(() => []),
      listRuns({ limit: 300 }).catch(() => []),
    ])
    return detectSlowdowns(hist, rows).map((s) => ({
      ...s,
      _ratioLabel: `${s.ratio.toFixed(1)}× slower`,
      // Only a CONFIRMED input change earns the regression dot. Same inputs
      // means the extra time is environment/variance, and no earlier keyed
      // run means there is no evidence either way — both read neutral.
      _dir: s.cause === 'inputs changed' ? 'slower' : 'unattributed',
      _cause: s.cause,
    }))
  },
  cacheBreakdown: () => getCacheBreakdown(100),
  storage: (p) => getStorageGrowth(windowDaysOf(p, 30)),
  cacheEntries: () => listCacheEntries({ limit: 200, orderBy: 'size_bytes' }),
  heatmap: (p) => getHeatmap(windowDaysOf(p, 30)),
  parallelism: () => getParallelismHistory(50),
  bottlenecks: (p) => getBottlenecks(windowDaysOf(p, 14), 25),
  flaky: () => getFlakiest(25),
  analysis: (p) => analysisData(windowDaysOf(p, 7)),
  regressions: (p) => regressionRows(windowDaysOf(p, 14)),
  prunable: () => getPrunable(7, 25),
  serverMeta: () => getMeta(),
  // Workspace catalog (colocated serves only) — null on a remote/older serve,
  // so catalog-backed cards gate on `<key>Status` and simply hide elsewhere.
  catalog: () => workspaceCatalog(),
  catalogTasks: () => fetchCatalogTasks().catch(() => null),
  artifacts: () => artifactRows(),
  hermeticity: () => hermeticityData(),
  // param-based (route params + query params, already decoded by the loader)
  taskDetail: async (p) => {
    const detail = await getTaskDetail(p.id ?? '')
    // `_debug` = the one-click debug jumps (single-dev lens: from a broken
    // task to its logs/artifact without hunting).
    return detail === null ? null : { ...detail, _debug: taskDebugRows(detail) }
  },
  // Per-entity "did MY performance improve or decrease?" trends.
  taskTrend: (p) => {
    const [project = '', task = ''] = (p.id ?? '').split('#', 2)
    return project !== '' && task !== '' ? scopedTrend({ project, task }) : Promise.resolve(null)
  },
  projectTrend: (p) =>
    (p.name ?? '') !== ''
      ? scopedTrend({ project: p.name! }, windowDaysOf(p, 7))
      : Promise.resolve(null),
  cacheKey: (p) => explainCacheKey(p.id ?? ''),
  // The flaky badge: non-null only when /v1/flakiness flags this task.
  taskFlaky: (p) => {
    const [project = '', task = ''] = (p.id ?? '').split('#', 2)
    return project !== '' && task !== '' ? getTaskFlaky(project, task) : Promise.resolve(null)
  },
  // Workspace-wide instability ranking — an unstable task makes every
  // duration comparison involving it unreliable. Empty ⇒ the card hides.
  leastStable: async () => {
    const rows = await getLeastStable(8).catch(() => [])
    return rows.map((r) => ({
      ...r,
      _taskRef: r.id,
      _cvPct: r.cv,
      _pm: `±${(r.cv * 100).toFixed(1)}%`,
    }))
  },
  // Task stability: how repeatable the computation is across executions of the
  // SAME cache key. Identical inputs cannot regress, so this spread is the
  // task's margin of error — and the floor under any cross-key claim. Null
  // (card hidden) when no key ran twice, so there is nothing measurable.
  taskStability: async (p) => {
    const [project = '', task = ''] = (p.id ?? '').split('#', 2)
    if (project === '' || task === '') return null
    const st = await getTaskStability(project, task).catch(() => null)
    if (st === null || st.keys === 0) return null
    // cv = stddev/mean, so one standard deviation IS ±cv of the mean. Halving
    // it would understate the task's real margin of error.
    const pct = (v: number) => `±${(v * 100).toFixed(1)}%`
    return {
      ...st,
      _typical: pct(st.cvMedian),
      _worst: pct(st.cvWorst),
      _range: `${(st.rangeMedian * 100).toFixed(0)}% min→max`,
      _basis: `${st.samples} executions of ${st.keys} identical input set${st.keys === 1 ? '' : 's'}`,
      _rows: st.byKey.map((k) => ({
        ...k,
        _spread: `${k.minMs}–${k.maxMs}ms`,
        _cvPct: k.cv,
      })),
    }
  },
  // S4 flake trend: per-day nondeterminism episodes for THIS task, with
  // first/last seen + direction. Null (card hidden) on a healthy task, an
  // older serve (404), or any fetch problem.
  taskFlakeTrend: async (p) => {
    const [project = '', task = ''] = (p.id ?? '').split('#', 2)
    if (project === '' || task === '') return null
    const trend = await getFlakeTrend(project, task).catch(() => null)
    if (trend === null) return null
    const view = foldFlakeTrend(trend, Date.now())
    if (view === null) return null
    return {
      ...view,
      _firstSeen: formatDate(view.firstSeenAt),
      _lastSeen: formatRelativeTime(view.lastSeenAt),
    }
  },
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
  // Batched re-run verdict for the whole run — one request (see fetchRunWhy).
  runWhy: (p) => fetchRunWhy(p.id ?? ''),
  // Batched failure triage — null (card hidden) when the run has no failures.
  // Display fields are derived HERE so the pure-JSON view binds plain paths.
  runTriage: (p) =>
    fetchRunTriage(p.id ?? '').then((rows) =>
      rows === null
        ? null
        : rows.map((r) => ({
            ...r,
            _label:
              r.verdict === 'flaky'
                ? 'flaky'
                : r.verdict === 'pre-existing'
                  ? 'already broken'
                  : 'new failure',
            _evidence:
              r.verdict === 'flaky'
                ? `the same cache key passed ${r.sameKeySuccesses}× in other runs — nondeterminism, not this change`
                : r.verdict === 'pre-existing'
                  ? 'the default branch’s latest run of this task is also failing — inherited, not introduced'
                  : r.keyChanged === null
                    ? 'first recorded run of this task'
                    : r.keyChanged
                      ? 'first failure of this key — this run changed the task’s inputs'
                      : 'first failure of this key',
            _evidenceRunId: r.verdict === 'pre-existing' ? r.defaultBranchRunId : r.previousRunId,
          })),
    ),
  runSelectedTask: (p) => runSelectedTask(p),
  invocationDetail: (p) => getInvocation(p.id ?? ''),
  compare: (p) => compareRuns(p.id ?? ''),
  compareRows: (p) => compareRows(p.id ?? ''),
  // Lifetime per-task aggregates for this project, ENRICHED with each task's
  // Δavg vs the prior window (the "did MY tasks get slower?" column). The
  // lifetime table stays all-time on purpose; the Δ column reads the window.
  projectTasks: (p) => {
    const name = p.name ?? ''
    if (name === '') return Promise.resolve([])
    return Promise.all([
      getHistory({ project: name, limit: 500 }),
      getAnalysis(windowDaysOf(p, 7), 1, 500, { project: name }),
    ]).then(([h, cmp]) => mergeMoverDelta(h, cmp?.movers))
  },
  // Point lookup by name — `listProjects(500).find(...)` rendered an EMPTY
  // detail page for every project past the first page on a big workspace.
  projectSummary: (p) => ((p.name ?? '') !== '' ? getProject(p.name!) : Promise.resolve(null)),
  // Recent executions for one-click debug (#2): row → the run with this task
  // pre-selected (logs open), hash → the cache entry.
  projectRecent: (p) =>
    (p.name ?? '') !== ''
      ? listRuns({ project: p.name!, limit: 100 }).then((rs) =>
          rs.map((r) => ({ ...r, _taskRef: `${r.project}#${r.task}` })),
        )
      : Promise.resolve([]),
  // Failures & runs over time for this project (#4).
  projectFailureTrend: (p) =>
    (p.name ?? '') !== ''
      ? getRunTrends({ ...trendArgsOf(p), project: p.name! }).then((r) => r.points)
      : Promise.resolve([]),
  // How this project ranks vs the others (#3) — three single-dev axes.
  projectRankings: (p) =>
    (p.name ?? '') !== ''
      ? getProjectRank(p.name!).then(rankAxes)
      : Promise.resolve(null),
  // Where each task first started failing, across branches (#5). null = older serve.
  projectBranchFailures: (p) =>
    (p.name ?? '') !== ''
      ? branchFailureRows(p.name!, windowDaysOf(p, 14))
      : Promise.resolve(null),
  // Per-task avg-duration sparklines over the window (#1 — spot outliers/spikes/
  // trends per task). null = older serve without /v1/trends/tasks.
  projectTaskTrends: (p) =>
    (p.name ?? '') !== ''
      ? projectTaskTrendItems(p.name!, trendArgsOf(p))
      : Promise.resolve(null),
  cacheEntry: (p) =>
    listCacheEntries({ limit: 500 }).then((es) => es.find((e) => e.hash === p.hash) ?? null),
  cacheEntryRuns: (p) => cacheEntryRuns(p.hash ?? ''),
}
