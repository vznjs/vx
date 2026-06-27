// HTTP client for the vx serve metrics API. Same shape locally or
// against a remote/hosted vx serve — the SPA is platform-agnostic.
//
// The base URL is resolved from the connection store; that store
// persists the user's choice to localStorage and defaults to
// http://localhost:4321 (vx serve's chosen origin lives in
// `.vx/serve.json`, but the SPA can't read disk — the user pastes
// the printed origin in, or accepts the default).

import { createSignal } from 'solid-js'

const STORAGE_KEY = 'vx-ui:origin'

function defaultOrigin(): string {
  // The dev server injects this; the hosted build falls back to the page's
  // own origin (correct when vx serve --ui hosts the SPA), and finally the
  // canonical local port.
  const injected = import.meta.env.VITE_DEFAULT_ORIGIN
  if (typeof injected === 'string' && injected.length > 0) return injected
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return 'http://localhost:4321'
}

function readStoredOrigin(): string {
  if (typeof localStorage === 'undefined') return defaultOrigin()
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored ?? defaultOrigin()
}

const [origin, setOrigin] = createSignal(readStoredOrigin())

export function getOrigin(): string {
  return origin()
}

export function getOriginSignal(): () => string {
  return origin
}

export function setOriginAndPersist(next: string): void {
  const trimmed = next.replace(/\/+$/, '').trim()
  setOrigin(trimmed)
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, trimmed)
}

async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(`${origin()}${pathname}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`${pathname}: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Types — mirror src/orchestrator/metrics.ts return shapes.
// ---------------------------------------------------------------------------

export interface RunSummaryRow {
  runId: string | null
  project: string
  task: string
  status: string
  exitCode: number
  durationMs: number
  startedAt: number
  endedAt: number
  cacheHit: boolean | null
  hash: string
  cpuMs: number | null
  peakRssBytes: number | null
  wallclockStartNs: string | null
  wallclockEndNs: string | null
}

export interface InvocationRow {
  runId: string
  startedAt: number
  endedAt: number
  taskCount: number
  failedCount: number
  hitCount: number
  totalDurationMs: number
}

export interface RunDetail {
  runId: string
  startedAt: number
  endedAt: number
  tasks: RunSummaryRow[]
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  hitRate24h: number
}

export interface TaskHistoryRow {
  id: string
  project: string
  task: string
  runs: number
  successes: number
  failures: number
  hits: number
  successRate: number
  hitRate: number
  failureMode: 'stable' | 'flaky-recoverable' | 'flaky-fatal'
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
  minDurationMs: number | undefined
  maxDurationMs: number | undefined
  avgDurationMs: number | undefined
  totalDurationMs: number
  lastSeenAt: number | undefined
}

export interface TopTaskRow {
  id: string
  project: string
  task: string
  runs: number
  totalDurationMs: number
  avgDurationMs: number
}

export interface FailureRow {
  runId: string | null
  project: string
  task: string
  exitCode: number
  durationMs: number
  startedAt: number
  hash: string
}

export interface CacheEntryRow {
  hash: string
  project: string
  task: string
  command: string
  exitCode: number
  durationMs: number
  sizeBytes: number
  createdAt: number
  accessedAt: number
}

export interface CacheProjectRow {
  project: string
  entries: number
  totalBytes: number
}

export interface CacheSavings {
  hitsLast24h: number
  estimatedTimeSavedMs: number
  estimatedTimeSavedTotalMs: number
}

export interface TaskDetail {
  project: string
  task: string
  aggregate: TaskHistoryRow | null
  recent: RunSummaryRow[]
  latestEntry: CacheEntryRow | null
}

export interface CacheKeyExplanation {
  taskId: string
  project: string
  task: string
  latestEntry: {
    hash: string
    command: string
    exitCode: number
    durationMs: number
    sizeBytes: number
    createdAt: number
  } | null
  note: string
}

export interface ServerVersion {
  protocol: string
  vx: string
  workspace: string
  channels: readonly string[]
  rpc: readonly string[]
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function getVersion(): Promise<ServerVersion> {
  return await getJson<ServerVersion>('/version')
}

export async function listInvocations(limit = 50): Promise<InvocationRow[]> {
  const r = await getJson<{ invocations: InvocationRow[] }>(`/v1/invocations?limit=${limit}`)
  return r.invocations
}

export async function listRuns(
  args: { runId?: string; limit?: number } = {},
): Promise<RunSummaryRow[]> {
  const params = new URLSearchParams()
  if (args.runId !== undefined) params.set('runId', args.runId)
  if (args.limit !== undefined) params.set('limit', String(args.limit))
  const r = await getJson<{ runs: RunSummaryRow[] }>(`/v1/runs?${params.toString()}`)
  return r.runs
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  try {
    return await getJson<RunDetail>(`/v1/runs/${encodeURIComponent(runId)}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

export async function getCacheStats(): Promise<CacheStats> {
  return await getJson<CacheStats>('/v1/cache/stats')
}

export async function getHistory(args: { limit?: number } = {}): Promise<TaskHistoryRow[]> {
  const params = new URLSearchParams()
  if (args.limit !== undefined) params.set('limit', String(args.limit))
  const r = await getJson<{ history: TaskHistoryRow[] }>(`/v1/history?${params.toString()}`)
  return r.history
}

export async function explainCacheKey(taskId: string): Promise<CacheKeyExplanation> {
  return await getJson<CacheKeyExplanation>(`/v1/explain/${encodeURIComponent(taskId)}`)
}

export async function getTopTasks(limit = 10): Promise<TopTaskRow[]> {
  const r = await getJson<{ tasks: TopTaskRow[] }>(`/v1/top-tasks?limit=${limit}`)
  return r.tasks
}

export async function getFailures(limit = 25): Promise<FailureRow[]> {
  const r = await getJson<{ failures: FailureRow[] }>(`/v1/failures?limit=${limit}`)
  return r.failures
}

export async function getCacheSavings(): Promise<CacheSavings> {
  return await getJson<CacheSavings>('/v1/cache/savings')
}

export async function getCacheBreakdown(limit = 20): Promise<CacheProjectRow[]> {
  const r = await getJson<{ projects: CacheProjectRow[] }>(`/v1/cache/breakdown?limit=${limit}`)
  return r.projects
}

export async function listCacheEntries(
  args: {
    limit?: number
    orderBy?: 'created_at' | 'accessed_at' | 'size_bytes' | 'duration_ms'
    project?: string
  } = {},
): Promise<CacheEntryRow[]> {
  const params = new URLSearchParams()
  if (args.limit !== undefined) params.set('limit', String(args.limit))
  if (args.orderBy !== undefined) params.set('orderBy', args.orderBy)
  if (args.project !== undefined) params.set('project', args.project)
  const r = await getJson<{ entries: CacheEntryRow[] }>(`/v1/cache/entries?${params.toString()}`)
  return r.entries
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail | null> {
  try {
    return await getJson<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

// -- Analytics shapes (mirrored from src/orchestrator/metrics.ts) -----------

export interface ProjectRollup {
  project: string
  taskCount: number
  runs: number
  failures: number
  hits: number
  hitRate: number
  totalDurationMs: number
  avgDurationMs: number
  cacheBytes: number
  cacheEntries: number
  lastRunAt: number | undefined
  estimatedTimeSavedMs: number
}

export interface TrendPoint {
  t: number
  runs: number
  hits: number
  failures: number
  totalDurationMs: number
}

export interface HeatmapCellApi {
  dayOfWeek: number
  hourOfDay: number
  runs: number
  totalDurationMs: number
}

export interface FlakyTask {
  id: string
  project: string
  task: string
  runs: number
  failures: number
  failureRate: number
  durationTailRatio: number | undefined
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
}

export interface BottleneckRow {
  id: string
  project: string
  task: string
  runsRecent: number
  totalDurationMs: number
  avgDurationMs: number
  runsPerDay: number
  weeklySavingsAt25PctCutMs: number
}

export interface ParallelismPoint {
  runId: string
  startedAt: number
  cpuSumMs: number
  wallMs: number
  factor: number
  taskCount: number
}

export interface StoragePoint {
  t: number
  bytesAdded: number
  entriesAdded: number
}

export interface PrunableEntry {
  hash: string
  project: string
  task: string
  sizeBytes: number
  createdAt: number
  accessedAt: number
  ageDays: number
}

export async function listProjects(limit = 100): Promise<ProjectRollup[]> {
  const r = await getJson<{ projects: ProjectRollup[] }>(`/v1/projects?limit=${limit}`)
  return r.projects
}

export async function getRunTrends(args: {
  bucket?: 'hour' | 'day'
  from?: number
  to?: number
} = {}): Promise<{ bucket: string; points: TrendPoint[] }> {
  const params = new URLSearchParams()
  if (args.bucket) params.set('bucket', args.bucket)
  if (args.from !== undefined) params.set('from', String(args.from))
  if (args.to !== undefined) params.set('to', String(args.to))
  return await getJson(`/v1/trends/runs?${params}`)
}

export async function getHeatmap(days = 30): Promise<HeatmapCellApi[]> {
  const r = await getJson<{ cells: HeatmapCellApi[] }>(`/v1/trends/heatmap?days=${days}`)
  return r.cells
}

export async function getStorageGrowth(days = 30): Promise<StoragePoint[]> {
  const r = await getJson<{ points: StoragePoint[] }>(`/v1/trends/storage?days=${days}`)
  return r.points
}

export async function getParallelismHistory(limit = 50): Promise<ParallelismPoint[]> {
  const r = await getJson<{ points: ParallelismPoint[] }>(`/v1/trends/parallelism?limit=${limit}`)
  return r.points
}

export async function getFlakiest(limit = 25): Promise<FlakyTask[]> {
  const r = await getJson<{ tasks: FlakyTask[] }>(`/v1/flakiness?limit=${limit}`)
  return r.tasks
}

export async function getBottlenecks(days = 14, limit = 15): Promise<BottleneckRow[]> {
  const r = await getJson<{ bottlenecks: BottleneckRow[] }>(
    `/v1/bottlenecks?days=${days}&limit=${limit}`,
  )
  return r.bottlenecks
}

export async function getPrunable(
  minAgeDays = 7,
  limit = 50,
): Promise<PrunableEntry[]> {
  const r = await getJson<{ entries: PrunableEntry[] }>(
    `/v1/cache/prunable?minAgeDays=${minAgeDays}&limit=${limit}`,
  )
  return r.entries
}

/**
 * Subscribe to live event stream via SSE. Returns an unsubscribe fn.
 * The hosted SPA uses this to overlay running tasks on the Overview.
 */
export function subscribeEvents(onMessage: (event: unknown) => void): () => void {
  const origin = getOrigin()
  const source = new EventSource(`${origin}/v1/events`)
  source.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data))
    } catch {
      // ignore malformed
    }
  }
  source.onerror = () => {
    // Connection lost — EventSource will auto-retry. The picker's
    // status dot reflects connectedness via the /version probe.
  }
  return () => source.close()
}

// ---------------------------------------------------------------------------
// Run cockpit — task graph + live run submission over WebSocket
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string
  project: string
  task: string
  isGroup: boolean
  deps: readonly string[]
  cacheStatus: 'hit-local' | 'hit-remote' | 'miss' | 'no-cache' | 'group'
}

/** Fetch the task DAG (nodes + edges + predicted cache status) for a task set. */
export async function getGraph(tasks: readonly string[]): Promise<GraphNode[]> {
  const r = await getJson<{ nodes: GraphNode[] }>(`/v1/graph?tasks=${encodeURIComponent(tasks.join(','))}`)
  return r.nodes
}

/** Live event from a delegated run (mirrors src/orchestrator/events.ts WireEvent). */
export type WireEvent =
  | { kind: 'run:start'; info: { total: number; concurrency?: number } }
  | { kind: 'task:start'; task: { id: string; project: string; task: string; isGroup: boolean; persistent: boolean; command?: string } }
  | { kind: 'task:stdout'; taskId: string; chunk: string }
  | { kind: 'task:stderr'; taskId: string; chunk: string }
  | { kind: 'task:complete'; outcome: { taskId: string; status: string; exitCode: number; durationMs: number; restored?: boolean; hash?: string; cpuMs?: number; peakRssBytes?: number } }
  | { kind: 'run:status'; line: string }
  | { kind: 'run:end' }

export interface RunHandlers {
  onEvent: (ev: WireEvent) => void
  onResult: (result: { ok: boolean }) => void
  onError: (message: string) => void
}

/**
 * Submit a run to `vx serve` over WebSocket and stream its events back.
 * Returns a cancel fn that closes the socket (the run keeps going
 * server-side, but the cockpit stops listening — used for supersede).
 */
export function runTasks(tasks: readonly string[], cwd: string, h: RunHandlers): () => void {
  const wsOrigin = getOrigin().replace(/^http/, 'ws')
  let ws: WebSocket
  try {
    ws = new WebSocket(wsOrigin)
  } catch (err) {
    h.onError(err instanceof Error ? err.message : String(err))
    return () => {}
  }
  ws.onopen = () => ws.send(JSON.stringify({ t: 'run', request: { tasks: [...tasks], cwd } }))
  ws.onmessage = (e) => {
    let m: { t: string; event?: WireEvent; result?: { ok: boolean }; message?: string }
    try {
      m = JSON.parse(String(e.data))
    } catch {
      return
    }
    if (m.t === 'event' && m.event) h.onEvent(m.event)
    else if (m.t === 'result' && m.result) {
      h.onResult(m.result)
      ws.close()
    } else if (m.t === 'error') {
      h.onError(m.message ?? 'run error')
      ws.close()
    }
  }
  ws.onerror = () => h.onError('connection error')
  return () => {
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
}
