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
const TOKEN_KEY = 'vx-ui:token'
const WORKSPACE_KEY = 'vx-ui:workspace'

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

// Bearer token for a token-gated vx serve. Persisted beside the origin;
// empty string = no token (the open localhost default).
function readStoredToken(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

const [token, setToken] = createSignal(readStoredToken())

// Flipped by any 401 so the shell can surface its token prompt.
const [unauthorized, setUnauthorized] = createSignal(false)

export function getToken(): string {
  return token()
}

export function getTokenSignal(): () => string {
  return token
}

export function setTokenAndPersist(next: string): void {
  const trimmed = next.trim()
  setToken(trimmed)
  if (typeof localStorage !== 'undefined') {
    if (trimmed === '') localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, trimmed)
  }
  setUnauthorized(false)
}

export function getUnauthorizedSignal(): () => boolean {
  return unauthorized
}

// ---------------------------------------------------------------------------
// Workspace — the Docker-context equivalent. A multi-workspace serve scopes
// every /v1/* analytics read by `?ws=<id>`; the selection persists beside the
// origin/token. Empty string = unset (the serve picks its sole workspace /
// 'default'), so the zero-config solo case never sends the param.
// ---------------------------------------------------------------------------

function readStoredWorkspace(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(WORKSPACE_KEY) ?? ''
}

const [workspace, setWorkspace] = createSignal(readStoredWorkspace())

export function getWorkspace(): string {
  return workspace()
}

export function getWorkspaceSignal(): () => string {
  return workspace
}

export function setWorkspaceAndPersist(next: string): void {
  const trimmed = next.trim()
  setWorkspace(trimmed)
  if (typeof localStorage !== 'undefined') {
    if (trimmed === '') localStorage.removeItem(WORKSPACE_KEY)
    else localStorage.setItem(WORKSPACE_KEY, trimmed)
  }
}

/**
 * Reactive `origin|token|workspace` key — everything a remote read depends
 * on. The jr page loader keys its data resources on this so views re-fetch
 * the moment the user switches connection or workspace.
 */
export function getConnectionKey(): string {
  return `${origin()}|${token()}|${workspace()}`
}

/** Workspace-list endpoints answer FOR all workspaces — never scoped by one. */
const WS_EXEMPT = new Set(['/v1/meta', '/v1/workspaces'])

/** Append `ws=<id>` to a /v1 pathname when a workspace is selected. */
function withWorkspace(pathname: string): string {
  const ws = workspace()
  if (ws === '' || !pathname.startsWith('/v1/')) return pathname
  const bare = pathname.split('?', 1)[0]!
  if (WS_EXEMPT.has(bare)) return pathname
  return `${pathname}${pathname.includes('?') ? '&' : '?'}ws=${encodeURIComponent(ws)}`
}

export interface WorkspaceInfo {
  id: string
  name: string
  lastSeenAt: number
  runCount?: number
}

const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([])
let workspacesKey: string | null = null

/** Workspaces known to the connected serve; `[]` until the list resolves. */
export function getWorkspacesSignal(): () => WorkspaceInfo[] {
  return workspaces
}

/**
 * (Re-)fetch the workspace list when the connection changed; no-op otherwise.
 * A single-workspace serve (or one predating /v1/workspaces) yields a list the
 * switcher hides. A persisted selection unknown to THIS serve is reset so
 * every query doesn't scope to a workspace that doesn't exist here.
 */
export function refreshWorkspaces(): void {
  const key = `${origin()}|${token()}`
  if (key === workspacesKey) return
  workspacesKey = key
  setWorkspaces([])
  void getWorkspaces().then(
    (list) => {
      if (workspacesKey !== key) return
      setWorkspaces(list)
      const current = workspace()
      if (current !== '' && !list.some((w) => w.id === current)) setWorkspaceAndPersist('')
    },
    () => {
      if (workspacesKey === key) setWorkspaces([])
    },
  )
}

// ---------------------------------------------------------------------------
// Capabilities — what THIS serve can actually answer.
//
// vx-cloud serve is ingest-only: its /v1/* analytics read the push-fed store,
// so cache-ENTRY surfaces (entries, heat, input diffs) are empty unless the
// serve has real entry data, and /v1/graph + WS run delegation need a
// colocated workspace. Probed ONCE per connection so views can degrade
// honestly ("not available here") instead of faking "no data".
// ---------------------------------------------------------------------------

export interface Capabilities {
  /** false until the probe resolves for the current connection. */
  known: boolean
  /** /v1/graph + run delegation work — the serve has a colocated workspace. */
  hasWorkspace: boolean
  /** Cache-entry-backed endpoints (entries / heat / input diff) have data. */
  hasCacheDb: boolean
}

const UNKNOWN_CAPS: Capabilities = { known: false, hasWorkspace: false, hasCacheDb: false }
const [capabilities, setCapabilities] = createSignal<Capabilities>(UNKNOWN_CAPS)
let capsKey: string | null = null

export function getCapabilitiesSignal(): () => Capabilities {
  return capabilities
}

/**
 * (Re-)probe capabilities when the connection changed; no-op otherwise.
 * The workspace probe is one /v1/graph call with a task nobody declares —
 * a colocated workspace answers `{ nodes: [] }` (200), a workspace-less
 * serve 400s from planRun.
 */
export function refreshCapabilities(): void {
  // Workspace participates: the cache-entry probe reads workspace-scoped data.
  const key = getConnectionKey()
  if (key === capsKey) return
  capsKey = key
  setCapabilities(UNKNOWN_CAPS)
  void Promise.all([
    getGraph(['__vx_capability_probe__']).then(
      () => true,
      () => false,
    ),
    getCacheStats().then(
      (s) => s.entryCount > 0,
      () => false,
    ),
  ]).then(([hasWorkspace, hasCacheDb]) => {
    if (capsKey === key) setCapabilities({ known: true, hasWorkspace, hasCacheDb })
  })
}

/** `?token=` suffix for EventSource/WebSocket URLs (headers unsupported there). */
function tokenQuery(prefix: '?' | '&' = '?'): string {
  const t = token()
  return t === '' ? '' : `${prefix}token=${encodeURIComponent(t)}`
}

async function getJson<T>(pathname: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = token()
  if (t !== '') headers['Authorization'] = `Bearer ${t}`
  const res = await fetch(`${origin()}${withWorkspace(pathname)}`, { headers })
  if (res.status === 401) {
    setUnauthorized(true)
    throw new Error(`${pathname}: 401 Unauthorized — this server requires a token`)
  }
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

/**
 * Rich per-invocation header (mirrors src/orchestrator/metrics.ts
 * `InvocationDetail`). Superset of `InvocationRow` — git/CI/host context, the
 * full command, tags, and the local/remote hit split.
 */
export interface InvocationDetail {
  runId: string
  command: string
  requestedTasks: string[]
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
  tags: Record<string, string>
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
  /** `status = 'cache-hit'` over the last 24h. */
  hitLocalCountLast24h: number
  /** `status = 'cache-hit-remote'` over the last 24h. */
  hitRemoteCountLast24h: number
}

/** One changed/added/removed cache-key component (metrics.ts `InputDiffEntry`). */
export interface InputDiffEntry {
  kind: string
  name: string
  change: 'added' | 'removed' | 'changed'
  /** The component's hash in the previous run (null when `added`). */
  before: string | null
  /** The component's hash in this run (null when `removed`). */
  after: string | null
}

/**
 * The input-fingerprint diff for one task between this run and its previous run
 * (mirrors metrics.ts `CacheKeyDiff`). `entries` holds only the components that
 * changed; unchanged ones are counted.
 */
export interface CacheKeyDiff {
  runId: string
  taskId: string
  found: boolean
  previousRunId: string | null
  entries: InputDiffEntry[]
  unchangedCount: number
  note: string
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

export interface CompareTaskSide {
  status: string
  durationMs: number
  hash: string
  cacheHit: boolean | null
  exitCode: number
}

export interface CompareTaskRow {
  taskId: string
  project: string
  task: string
  a: CompareTaskSide | null
  b: CompareTaskSide | null
  hashChanged: boolean
  durationDeltaMs: number | null
  statusChanged: boolean
}

export interface CompareRuns {
  runId: string
  previousRunId: string | null
  startedAt: number | null
  prevStartedAt: number | null
  found: boolean
  summary: {
    aTotalMs: number
    bTotalMs: number
    totalDeltaMs: number
    tasksChanged: number
    tasksOnlyInA: number
    tasksOnlyInB: number
  }
  tasks: CompareTaskRow[]
  note: string
}

export interface ServerVersion {
  protocol: string
  vx: string
  workspace: string
  channels: readonly string[]
  rpc: readonly string[]
}

/** Server identity from the auth-exempt /v1/meta (no workspace path, no secrets). */
export interface ServerMeta {
  v: number
  name: string
  vx: string
  auth: 'token' | 'open'
  startedAt: number
  /** Workspace count on this serve (absent on serves predating workspaces). */
  workspaces?: number
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function getVersion(): Promise<ServerVersion> {
  return await getJson<ServerVersion>('/version')
}

export async function getMeta(): Promise<ServerMeta> {
  return await getJson<ServerMeta>('/v1/meta')
}

/** List the workspaces the connected serve holds (multi-repo serves). */
export async function getWorkspaces(): Promise<WorkspaceInfo[]> {
  const r = await getJson<{ workspaces: WorkspaceInfo[] }>('/v1/workspaces')
  return r.workspaces
}

export interface ListInvocationsArgs {
  limit?: number
  branch?: string
  ci?: boolean
  tagKey?: string
  tagValue?: string
}

/**
 * List `vx run` invocations newest-first with optional branch / ci / tag
 * filters. Accepts a bare `number` for back-compat with the old
 * `listInvocations(50)` signature. Returns the rich `InvocationDetail` (a
 * superset of the old `InvocationRow` shape, so existing callers keep working).
 */
export async function listInvocations(
  args: ListInvocationsArgs | number = {},
): Promise<InvocationDetail[]> {
  const opts: ListInvocationsArgs = typeof args === 'number' ? { limit: args } : args
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.branch !== undefined) params.set('branch', opts.branch)
  if (opts.ci !== undefined) params.set('ci', opts.ci ? '1' : '0')
  if (opts.tagKey !== undefined) params.set('tagKey', opts.tagKey)
  if (opts.tagValue !== undefined) params.set('tagValue', opts.tagValue)
  const r = await getJson<{ invocations: InvocationDetail[] }>(
    `/v1/invocations?${params.toString()}`,
  )
  return r.invocations
}

/** Fetch one invocation header (git/CI/host context, tags, hit split). */
export async function getInvocation(runId: string): Promise<InvocationDetail | null> {
  try {
    return await getJson<InvocationDetail>(`/v1/invocations/${encodeURIComponent(runId)}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  try {
    return await getJson<RunDetail>(`/v1/runs/${encodeURIComponent(runId)}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

/** A task's persisted log tail. `source: 'cache'` resolves a hit to the run
 *  that produced the bytes (`refRunId`); `artifactHash` present when the
 *  serve holds a downloadable /v8 artifact for the requester's principal. */
export interface TaskLogResponse {
  runId: string
  taskId: string
  source: 'executed' | 'cache'
  refRunId?: string
  status: 'success' | 'failed'
  content: string
  charsFull: number
  truncatedHeadChars: number
  artifactHash?: string
}

export async function getTaskLog(runId: string, taskId: string): Promise<TaskLogResponse | null> {
  try {
    return await getJson<TaskLogResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(taskId)}`,
    )
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

/**
 * The input-fingerprint moat: name the exact cache-key components (files / env /
 * runtime / upstream …) that differ between this run of a task and its
 * immediately-previous run. Always resolves (a missing run/task is a
 * `found: false` body, not an HTTP error).
 */
export async function cacheKeyDiff(runId: string, taskId: string): Promise<CacheKeyDiff> {
  return await getJson<CacheKeyDiff>(
    `/v1/diff/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}`,
  )
}

/**
 * Diff a run against the immediately-previous invocation: per-task duration /
 * status / cache-key deltas. Always resolves (a missing/no-previous run is a
 * `found: false` body, not an HTTP error).
 */
export async function compareRuns(runId: string): Promise<CompareRuns> {
  return await getJson<CompareRuns>(`/v1/compare/${encodeURIComponent(runId)}`)
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
  // EventSource can't set headers — the token rides the query string.
  const path = withWorkspace('/v1/events')
  const source = new EventSource(`${origin}${path}${tokenQuery(path.includes('?') ? '&' : '?')}`)
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
    // Browser WebSocket can't set headers — the token rides the query string.
    ws = new WebSocket(`${wsOrigin}/${tokenQuery()}`)
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
