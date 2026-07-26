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
const ORG_KEY = 'vx-ui:org'
const WORKSPACE_KEY = 'vx-ui:workspace'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

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

// --- Session / account auth (cloud-platform-2026-07 §6) ---------------------
// The platform authenticates the dashboard with an HttpOnly SESSION COOKIE, not
// a bearer token: every request rides `credentials: 'include'` so the browser
// returns the cookie, and every state-changing request carries `x-vx-csrf: 1`
// (a custom header a cross-site form can't forge). A 401 on any gated read
// flips authState to 'anon' → the full-screen login gate.

export type AuthState = 'loading' | 'anon' | 'authed'

export interface CurrentUser {
  userId: string
  email: string
  displayName: string
  instanceAdmin: boolean
  orgs: { orgId: string; role: OrgRole }[]
}

const [authState, setAuthState] = createSignal<AuthState>('loading')
const [currentUser, setCurrentUser] = createSignal<CurrentUser | null>(null)

export function getAuthStateSignal(): () => AuthState {
  return authState
}

export function getCurrentUserSignal(): () => CurrentUser | null {
  return currentUser
}

// --- Org clamp --------------------------------------------------------------
// A session spanning >1 org must name which org each analytics read targets
// (`?org=`); a single-org session may omit it, but the client always sends the
// selected org for determinism. Persisted beside the origin (`vx-ui:org`).

function readStoredOrg(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(ORG_KEY) ?? ''
}

const [org, setOrg] = createSignal(readStoredOrg())

export function getOrg(): string {
  return org()
}

export function getOrgSignal(): () => string {
  return org
}

export function setOrgAndPersist(next: string): void {
  const trimmed = next.trim()
  if (trimmed === org()) return
  setOrg(trimmed)
  if (typeof localStorage !== 'undefined') {
    if (trimmed === '') localStorage.removeItem(ORG_KEY)
    else localStorage.setItem(ORG_KEY, trimmed)
  }
  // Workspaces are org-scoped — a stale selection must not ride the new org.
  setWorkspaceAndPersist('')
}

export interface OrgSummary {
  id: string
  slug: string
  name: string
  role: OrgRole
}

const [orgs, setOrgs] = createSignal<OrgSummary[]>([])

export function getOrgsSignal(): () => OrgSummary[] {
  return orgs
}

/**
 * Choose the org to target for the next reads: keep the stored one when the
 * principal is still a member, else the first available (server-sorted). Pure
 * — exported for tests; the caller persists the result.
 */
export function nextOrgSelection(list: readonly { id: string }[], current: string): string {
  if (list.length === 0) return ''
  if (current !== '' && list.some((o) => o.id === current)) return current
  return list[0]!.id
}

function reconcileOrgSelection(list: readonly { id: string }[]): void {
  setOrgAndPersist(nextOrgSelection(list, org()))
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
 * Reactive key for everything a remote read depends on — the connected origin,
 * the signed-in user (so login/logout re-fetches), the selected org, and the
 * selected workspace. The jr page loader keys its resources on this so views
 * re-fetch the moment any of them changes.
 */
export function getConnectionKey(): string {
  return `${origin()}|${currentUser()?.userId ?? ''}|${org()}|${workspace()}`
}

/** Reads that answer for the whole org — never scoped by one workspace. */
const WS_EXEMPT = new Set(['/v1/meta', '/v1/workspaces'])
/** Auth-exempt surfaces that must not carry `?org=`. */
const ORG_EXEMPT = new Set(['/v1/meta'])

/**
 * Append the org + workspace clamp to a `/v1/*` analytics pathname. Pure —
 * exported for tests. `/v1/auth/*` and `/v1/admin/*` carry their scope in the
 * body / path, so they're left untouched.
 */
export function scopedPathFor(pathname: string, orgId: string, ws: string): string {
  if (!pathname.startsWith('/v1/')) return pathname
  const bare = pathname.split('?', 1)[0]!
  if (bare.startsWith('/v1/auth/') || bare.startsWith('/v1/admin/')) return pathname
  let p = pathname
  const add = (kv: string): void => {
    p = `${p}${p.includes('?') ? '&' : '?'}${kv}`
  }
  if (orgId !== '' && !ORG_EXEMPT.has(bare)) add(`org=${encodeURIComponent(orgId)}`)
  if (ws !== '' && !WS_EXEMPT.has(bare)) add(`ws=${encodeURIComponent(ws)}`)
  return p
}

function scopedPath(pathname: string): string {
  return scopedPathFor(pathname, org(), workspace())
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
  const key = `${origin()}|${org()}|${currentUser()?.userId ?? ''}`
  if (key === workspacesKey) return
  workspacesKey = key
  setWorkspaces([])
  if (authState() !== 'authed') return
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
  /** The /v1/workspace/* catalog routes answer (advertised by /v1/meta). */
  catalog: boolean
  /** The serve hosts a run queue (`/v1/runs/queue`, advertised by /v1/meta).
   *  The platform does NOT — polling a removed endpoint is a guaranteed 404
   *  every 2s, so the Runs view gates its queue poll on this. */
  queue: boolean
}

const UNKNOWN_CAPS: Capabilities = {
  known: false,
  hasWorkspace: false,
  hasCacheDb: false,
  catalog: false,
  queue: false,
}
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
    getMeta().then(
      (m) => ({ catalog: m.catalog === true, queue: m.queue === true }),
      () => ({ catalog: false, queue: false }),
    ),
  ]).then(([hasWorkspace, hasCacheDb, meta]) => {
    if (capsKey === key) setCapabilities({ known: true, hasWorkspace, hasCacheDb, ...meta })
  })
}

// In-flight GET de-duplication. A view's sources are fetched concurrently, so
// two that hit the SAME URL fire two identical requests — run-detail's `run` +
// `runSelectedTask` both GET /v1/runs/:id (the largest query, doubled every 5s
// poll on the common `?task=` deep-link), and task-detail's detail/flaky/config
// sources overlap the `recommendations` aggregator's own fetches. Coalescing
// concurrent identical GETs into one shared promise removes the waste. Cleared
// on settle, so the next poll fetches fresh — this is request coalescing, not a
// cache.
const inflightGets = new Map<string, Promise<unknown>>()

async function getJson<T>(pathname: string): Promise<T> {
  const url = `${origin()}${scopedPath(pathname)}`
  const existing = inflightGets.get(url)
  if (existing !== undefined) return existing as Promise<T>
  const p = doGetJson<T>(pathname, url).finally(() => inflightGets.delete(url))
  inflightGets.set(url, p)
  return p
}

async function doGetJson<T>(pathname: string, url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 401) {
    setAuthState('anon')
    throw new Error(`${pathname}: 401 Unauthorized`)
  }
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

/** Result of a state-changing request (CSRF header + cookie credentials). */
export interface MutateResult<T> {
  ok: boolean
  status: number
  data?: T
  error?: string
}

async function mutate<T = unknown>(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<MutateResult<T>> {
  try {
    const headers: Record<string, string> = { 'x-vx-csrf': '1', Accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${origin()}${scopedPath(pathname)}`, {
      method,
      credentials: 'include',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 401) setAuthState('anon')
    const data = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined
    if (!res.ok) return { ok: false, status: res.status, error: data?.error ?? res.statusText }
    return { ok: true, status: res.status, ...(data !== undefined ? { data } : {}) }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
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

/** Server identity from the auth-exempt /v1/meta (no tenant data, no secrets). */
export interface ServerMeta {
  v: number
  name: string
  vx: string
  /** 'account' = the platform (sessions + RBAC); legacy serves report token/open. */
  auth: 'account' | 'token' | 'open'
  startedAt: number
  /** Workspace count on this serve (absent on serves predating workspaces). */
  workspaces?: number
  /** This serve hosts the artifact store (`/v1/cache/:hash`). */
  artifacts?: boolean
  /** Artifact-store wire version (1 = the vx-native /v1/cache wire). */
  cacheWire?: number
  /** A colocated workspace makes the /v1/workspace/* catalog live. */
  catalog?: boolean
  /** The serve hosts a run queue (`/v1/runs/queue`); absent on the platform. */
  queue?: boolean
  /** The platform partitions the cache by trust tier. */
  trustTiers?: boolean
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

/** Per-task run rows, filterable by project / task / runId (`/v1/runs`). */
export async function listRuns(
  args: { limit?: number; project?: string; task?: string; runId?: string; hash?: string } = {},
): Promise<RunSummaryRow[]> {
  const params = new URLSearchParams()
  if (args.limit !== undefined) params.set('limit', String(args.limit))
  if (args.project !== undefined) params.set('project', args.project)
  if (args.task !== undefined) params.set('task', args.task)
  if (args.runId !== undefined) params.set('runId', args.runId)
  if (args.hash !== undefined) params.set('hash', args.hash)
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

/** A task's persisted log tail. `source: 'cache'` resolves a hit to the run
 *  that produced the bytes (`refRunId`); `artifactHash` present when the
 *  serve holds a downloadable artifact for the requester's principal. */
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

export async function getCacheStats(windowDays?: number): Promise<CacheStats> {
  const q = windowDays !== undefined ? `?windowDays=${windowDays}` : ''
  return await getJson<CacheStats>(`/v1/cache/stats${q}`)
}

export async function getHistory(
  args: { limit?: number; project?: string; task?: string } = {},
): Promise<TaskHistoryRow[]> {
  const params = new URLSearchParams()
  if (args.limit !== undefined) params.set('limit', String(args.limit))
  if (args.project !== undefined) params.set('project', args.project)
  if (args.task !== undefined) params.set('task', args.task)
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

/** One executed task's re-run verdict — the batched `/v1/why/:runId` row. */
export interface WhyRunRow {
  taskId: string
  project: string
  task: string
  previousRunId: string | null
  reason: string
}

/**
 * Batched "why did this re-run" for a whole run — one request over every
 * executed task, replacing the per-task `/v1/diff` fan-out. Returns [] on an
 * older serve that lacks the route (404), so the panel degrades cleanly.
 */
export async function fetchRunWhy(runId: string): Promise<WhyRunRow[]> {
  try {
    const r = await getJson<{ rows: WhyRunRow[] }>(`/v1/why/${encodeURIComponent(runId)}`)
    return r.rows
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return []
    throw err
  }
}

/** One failed task's triage verdict — the batched `/v1/triage/:runId` row. */
export interface TriageRow {
  taskId: string
  project: string
  task: string
  verdict: 'flaky' | 'pre-existing' | 'new-failure'
  sameKeySuccesses: number
  defaultBranchFailing: boolean
  defaultBranchRunId: string | null
  keyChanged: boolean | null
  previousRunId: string | null
}

/**
 * Batched failure triage — "is this failure mine?" for every failed task of a
 * run. Returns null when the run has no failures (the card hides) and on an
 * older serve that lacks the route (404), so the panel degrades cleanly.
 */
export async function fetchRunTriage(runId: string): Promise<TriageRow[] | null> {
  try {
    const r = await getJson<{ rows: TriageRow[] }>(`/v1/triage/${encodeURIComponent(runId)}`)
    return r.rows.length === 0 ? null : r.rows
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
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

/** The latest cache-key entry for a task (metrics.ts `CacheKeyExplanation`). */
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

export async function explainCacheKey(taskId: string): Promise<CacheKeyExplanation> {
  return await getJson<CacheKeyExplanation>(`/v1/explain/${encodeURIComponent(taskId)}`)
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
  /** Runs that needed more than one attempt — the CONFIRMED flaky signal. */
  withinRunRetries: number
  maxAttempts: number | undefined
  /** True when `withinRunRetries > 0` — flakiness confirmed, not inferred. */
  flakyConfirmed: boolean
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

export interface RegressedTask {
  id: string
  project: string
  task: string
  branchesFailing: number
  branchesTotal: number
  branches: string[]
  regressed: boolean
  firstFailedAt: number
  lastRunAt: number
  failures: number
  runs: number
}

export interface ProjectBranchFailure {
  task: string
  firstBranch: string
  firstFailedAt: number
  firstCommit: string | null
  lastFailedAt: number
  branchesFailing: number
  branches: { branch: string; firstFailedAt: number; firstCommit: string | null; failures: number }[]
}

export interface PeriodStats {
  runs: number
  taskRuns: number
  executed: number
  failures: number
  cacheHits: number
  totalDurationMs: number
  avgDurationMs: number
  p50DurationMs: number | undefined
  p95DurationMs: number | undefined
  failureRate: number
  cacheHitRate: number
}

export interface TaskMover {
  id: string
  project: string
  task: string
  currentAvgMs: number
  previousAvgMs: number
  deltaMs: number
  deltaPct: number
  currentRuns: number
  previousRuns: number
}

export interface PeriodComparison {
  windowDays: number
  current: { from: number; to: number; stats: PeriodStats }
  previous: { from: number; to: number; stats: PeriodStats }
  movers: TaskMover[]
}

export async function listProjects(limit = 100): Promise<ProjectRollup[]> {
  const r = await getJson<{ projects: ProjectRollup[] }>(`/v1/projects?limit=${limit}`)
  return r.projects
}

/** The projects page PLUS the workspace's true project count. */
export async function listProjectsPage(
  args: { limit?: number; search?: string } = {},
): Promise<{ projects: ProjectRollup[]; total: number }> {
  const qs = new URLSearchParams()
  qs.set('limit', String(args.limit ?? 200))
  if (args.search !== undefined && args.search !== '') qs.set('search', args.search)
  return getJson<{ projects: ProjectRollup[]; total: number }>(`/v1/projects?${qs.toString()}`)
}

/** One project's rollup by EXACT name — a point lookup, so a project outside
 *  the first page still resolves its own detail page. */
export async function getProject(project: string): Promise<ProjectRollup | null> {
  const r = await getJson<{ projects: ProjectRollup[] }>(
    `/v1/projects?project=${encodeURIComponent(project)}&limit=1`,
  )
  return r.projects[0] ?? null
}

export interface ProjectRankRow {
  project: string
  rank: number
  value: number
  me: boolean
}

/** Per-axis ranking against EVERY project (true ranks + true total). */
export async function getProjectRank(
  project: string,
): Promise<{
  total: number
  byFailRate: ProjectRankRow[]
  byAvg: ProjectRankRow[]
  byHitRate: ProjectRankRow[]
}> {
  return getJson(`/v1/projects/rank?project=${encodeURIComponent(project)}`)
}

export async function getRunTrends(args: {
  bucket?: 'hour' | 'day'
  from?: number
  to?: number
  project?: string
} = {}): Promise<{ bucket: string; points: TrendPoint[] }> {
  const params = new URLSearchParams()
  if (args.bucket) params.set('bucket', args.bucket)
  if (args.from !== undefined) params.set('from', String(args.from))
  if (args.to !== undefined) params.set('to', String(args.to))
  if (args.project !== undefined) params.set('project', args.project)
  return await getJson(`/v1/trends/runs?${params}`)
}

export interface ProjectTaskTrendPoint {
  task: string
  t: number
  runs: number
  failures: number
  avgDurationMs: number
  p95DurationMs: number
}

/**
 * Per-task, per-bucket time-series for the project view's task sparklines.
 * `null` on an older serve without /v1/trends/tasks so the card degrades.
 */
export async function getProjectTaskTrends(
  project: string,
  args: { bucket?: 'hour' | 'day'; from?: number; to?: number; limit?: number } = {},
): Promise<ProjectTaskTrendPoint[] | null> {
  try {
    const params = new URLSearchParams({ project })
    if (args.bucket) params.set('bucket', args.bucket)
    if (args.from !== undefined) params.set('from', String(args.from))
    if (args.to !== undefined) params.set('to', String(args.to))
    if (args.limit !== undefined) params.set('limit', String(args.limit))
    const r = await getJson<{ points: ProjectTaskTrendPoint[] }>(`/v1/trends/tasks?${params}`)
    return r.points
  } catch {
    return null
  }
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

/** The flaky verdict for ONE task — a point lookup, so the badge survives on a
 *  workspace with more flaky tasks than any top-N page can hold. */
export async function getTaskFlaky(project: string, task: string): Promise<FlakyTask | null> {
  const r = await getJson<{ tasks: FlakyTask[] }>(
    `/v1/flakiness?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&limit=1`,
  )
  return r.tasks[0] ?? null
}

export interface FlakeTrendPoint {
  t: number
  runs: number
  failures: number
  retried: number
  mixedFailures: number
}

export interface FlakeTrendResponse {
  points: FlakeTrendPoint[]
  episodes: number
  firstSeenAt: number | null
  lastSeenAt: number | null
}

export interface StabilitySample {
  hash: string
  runs: number
  minMs: number
  maxMs: number
  p50Ms: number
  meanMs: number
  stddevMs: number
  cv: number
}

export interface TaskStabilityResponse {
  samples: number
  keys: number
  cvMedian: number
  cvWorst: number
  rangeMedian: number
  byKey: StabilitySample[]
}

/** Same-key duration spread — the task's own margin of error. */
export async function getTaskStability(
  project: string,
  task: string,
  sinceDays = 90,
): Promise<TaskStabilityResponse> {
  return getJson<TaskStabilityResponse>(
    `/v1/stability?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&sinceDays=${sinceDays}`,
  )
}

export async function getFlakeTrend(
  project: string,
  task: string,
  sinceDays = 90,
): Promise<FlakeTrendResponse> {
  return getJson<FlakeTrendResponse>(
    `/v1/flake-trend?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&sinceDays=${sinceDays}`,
  )
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
 * Tasks that started failing across branches (used to pass, now failing on
 * >= minBranches distinct branches). `null` on an older serve without the
 * /v1/regressions route so the card degrades to an empty state.
 */
export async function getRegressions(
  sinceDays = 14,
  minBranches = 2,
  limit = 25,
): Promise<RegressedTask[] | null> {
  try {
    const r = await getJson<{ tasks: RegressedTask[] }>(
      `/v1/regressions?sinceDays=${sinceDays}&minBranches=${minBranches}&limit=${limit}`,
    )
    return r.tasks
  } catch {
    return null
  }
}

/**
 * Period-over-period comparison (this window vs the previous equal-length one).
 * Optional `scope` narrows to one project / one task — the entity pages'
 * "did MY performance improve or decrease?" trend. `null` on an older serve
 * without the /v1/analysis route.
 */
export async function getAnalysis(
  windowDays = 7,
  minRuns = 3,
  limit = 8,
  scope?: { project?: string; task?: string },
): Promise<PeriodComparison | null> {
  try {
    const params = new URLSearchParams({
      window: String(windowDays),
      minRuns: String(minRuns),
      limit: String(limit),
    })
    if (scope?.project !== undefined) params.set('project', scope.project)
    if (scope?.task !== undefined) params.set('task', scope.task)
    return await getJson<PeriodComparison>(`/v1/analysis?${params.toString()}`)
  } catch {
    return null
  }
}

/**
 * Per-task, per-branch failure attribution for the project view — which branch
 * each task FIRST started failing on ("where was the issue first noticed").
 * `null` on an older serve without the /v1/branch-failures route so the card
 * degrades to an empty state.
 */
export async function getProjectBranchFailures(
  project: string,
  sinceDays = 14,
  limit = 25,
): Promise<ProjectBranchFailure[] | null> {
  try {
    const params = new URLSearchParams({
      project,
      sinceDays: String(sinceDays),
      limit: String(limit),
    })
    const r = await getJson<{ tasks: ProjectBranchFailure[] }>(`/v1/branch-failures?${params}`)
    return r.tasks
  } catch {
    return null
  }
}

/**
 * Subscribe to live event stream via SSE. Returns an unsubscribe fn.
 * The hosted SPA uses this to overlay running tasks on the Overview.
 */
export function subscribeEvents(onMessage: (event: unknown) => void): () => void {
  const origin = getOrigin()
  // Same-origin EventSource returns the session cookie automatically; the dev
  // proxy needs withCredentials to forward it.
  const source = new EventSource(`${origin}${scopedPath('/v1/events')}`, { withCredentials: true })
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
    // Same-origin WebSocket carries the session cookie on the handshake.
    ws = new WebSocket(`${wsOrigin}/`)
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

// ---------------------------------------------------------------------------
// Workspace catalog — the /v1/workspace/* routes (colocated serves only).
// Shapes mirror packages/cloud/src/workspace-catalog.ts.
// ---------------------------------------------------------------------------

export interface CatalogProjectSummary {
  name: string
  /** Workspace-root-relative POSIX dir; `.` for the root project. */
  dir: string
  configPath: string
  taskCount: number
  tasks: string[]
}

export interface CatalogProjectsResponse {
  source: 'lock' | 'live'
  root: string
  workspaceId: string
  /** Lock file mtime (lock mode only). */
  lockedAt?: number
  /** Lock mode: projects whose config bytes drifted since `vx lock`. */
  staleProjects?: string[]
  projects: CatalogProjectSummary[]
}

export interface CatalogProjectDetail {
  source: 'lock' | 'live'
  name: string
  dir: string
  configPath: string
  stale?: boolean
  /** Resolved, JSON-normalized config — the `vx show` payload. */
  config: unknown
}

export interface CatalogTaskRow {
  id: string
  project: string
  task: string
  description?: string
  group: boolean
  cacheable: boolean
  persistent: boolean
  dependsOn: readonly string[]
}

export interface CatalogTasksResponse {
  source: 'lock' | 'live'
  tasks: CatalogTaskRow[]
}

export async function fetchCatalogProjects(): Promise<CatalogProjectsResponse> {
  return await getJson<CatalogProjectsResponse>('/v1/workspace/projects')
}

export async function fetchCatalogProject(name: string): Promise<CatalogProjectDetail | null> {
  try {
    return await getJson<CatalogProjectDetail>(`/v1/workspace/projects/${encodeURIComponent(name)}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

export async function fetchCatalogTasks(): Promise<CatalogTasksResponse> {
  return await getJson<CatalogTasksResponse>('/v1/workspace/tasks')
}

// ---------------------------------------------------------------------------
// Artifacts — the artifact store made visible (GET /v1/artifacts). NOT
// workspace-gated: artifacts exist on remote serves too. Shapes mirror
// packages/cloud/src/artifact-store.ts `ArtifactListEntry` + the serve's
// best-effort provenance join.
// ---------------------------------------------------------------------------

export interface ArtifactRow {
  hash: string
  sizeBytes: number
  /** When the artifact landed in the store (ms epoch). */
  storedAt: number
  /** Original task duration from the `.duration` sidecar, when present. */
  durationMs?: number
  tier: 'trusted' | 'untrusted'
  /** Most-recent producing task/run from the ingest db; absent when unknown. */
  task?: { project: string; task: string; runId?: string }
}

/** List readable artifacts, newest first. `null` = older serve (no route). */
export async function fetchArtifacts(limit = 200): Promise<ArtifactRow[] | null> {
  try {
    const r = await getJson<{ artifacts: ArtifactRow[] }>(`/v1/artifacts?limit=${limit}`)
    return r.artifacts
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// Hermeticity — GET /v1/hermeticity (verify-cross-machine §4): cache keys
// whose fingerprinted output trees diverge across reports, rels named.
// ---------------------------------------------------------------------------

export interface HermeticityReportRow {
  os: string
  arch: string
  tree: string
  runId: string
  host: string | null
  at: number
}

export interface DivergentKeyRow {
  hash: string
  taskId: string
  /** false ⇒ same-platform run-to-run divergence. */
  crossPlatform: boolean
  changed: string[]
  /** false when any report was tree-only/truncated — `changed` may be partial. */
  changedComplete: boolean
  reports: HermeticityReportRow[]
}

export interface HermeticityResponse {
  divergent: DivergentKeyRow[]
  keysTracked: number
  reportCount: number
}

/** Cross-machine fingerprint divergence. `null` = older serve (no route). */
export async function fetchHermeticity(limit = 50): Promise<HermeticityResponse | null> {
  try {
    return await getJson<HermeticityResponse>(`/v1/hermeticity?limit=${limit}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

/**
 * Bearer-fetch an artifact (`GET /v1/cache/:hash`) and hand it to the
 * browser as a download — the ONE download path shared by TaskLogs, the
 * artifacts table, and the entity-page download actions (an <a href> can't
 * carry the bearer header).
 */
export async function downloadArtifact(hash: string): Promise<boolean> {
  const res = await fetch(`${origin()}/v1/cache/${encodeURIComponent(hash)}`, {
    credentials: 'include',
  })
  if (!res.ok) return false
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `${hash}.tar.zst`
  a.click()
  URL.revokeObjectURL(url)
  return true
}

// ---------------------------------------------------------------------------
// Run queue — the serve-side FIFO every serve-executed run rides
// (protocol-queue.ts). One WS per submitted job: the submitting socket IS the
// stream, so after queue:start the standard event/result wire flows on it.
// ---------------------------------------------------------------------------

/** Mirror of the serve's JobView (`GET /v1/runs/queue`). */
export interface QueueJobRow {
  jobId: string
  tasks: readonly string[]
  state: 'queued' | 'running'
  /** 0 = running; queued jobs count the jobs ahead of them. */
  position: number
  submittedAt: number
  startedAt?: number
}

/** Live queue state (queued + running jobs; done jobs drop out). */
export async function fetchQueue(): Promise<QueueJobRow[]> {
  const r = await getJson<{ jobs: QueueJobRow[] }>('/v1/runs/queue')
  return r.jobs
}

export interface QueueRunHandlers {
  onAccepted: (jobId: string, position: number) => void
  /** Earlier jobs finished — this job's queue position dropped. */
  onPosition: (position: number) => void
  onStart: () => void
  onEvent: (ev: WireEvent) => void
  /** The run's own result frame (the summary footer follows on events). */
  onResult: (ok: boolean) => void
  /** Terminal: the job left the queue. runId links to /runs/:id. */
  onDone: (ok: boolean, runId?: string) => void
  onRefused: (message: string) => void
  onError: (message: string) => void
}

const QUEUE_PROTOCOL_VERSION = 1

/**
 * Submit one job to the serve's run queue and stream its lifecycle + events
 * back over a dedicated WebSocket. `cancel()` withdraws a QUEUED job
 * (queue:cancel + close); for a RUNNING job it stops watching — the run
 * completes server-side (the established stop semantics).
 */
export function queueRun(
  tasks: readonly string[],
  cwd: string,
  h: QueueRunHandlers,
): { cancel: () => void } {
  const wsOrigin = getOrigin().replace(/^http/, 'ws')
  let ws: WebSocket
  try {
    // Same-origin WebSocket carries the session cookie on the handshake.
    ws = new WebSocket(`${wsOrigin}/`)
  } catch (err) {
    h.onError(err instanceof Error ? err.message : String(err))
    return { cancel: () => {} }
  }
  let jobId: string | null = null
  let settled = false
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        t: 'queue:submit',
        v: QUEUE_PROTOCOL_VERSION,
        request: { tasks: [...tasks], cwd },
      }),
    )
  ws.onmessage = (e) => {
    let m: {
      t?: string
      jobId?: string
      position?: number
      runId?: string
      ok?: boolean
      message?: string
      event?: WireEvent
      result?: { ok: boolean }
    }
    try {
      m = JSON.parse(String(e.data))
    } catch {
      return
    }
    switch (m.t) {
      case 'queue:accepted':
        jobId = m.jobId ?? null
        h.onAccepted(m.jobId ?? '', m.position ?? 0)
        break
      case 'queue:update':
        h.onPosition(m.position ?? 0)
        break
      case 'queue:start':
        h.onStart()
        break
      case 'queue:done':
        settled = true
        h.onDone(m.ok === true, m.runId)
        ws.close()
        break
      case 'queue:refused':
        settled = true
        h.onRefused(m.message ?? 'refused')
        ws.close()
        break
      case 'event':
        if (m.event) h.onEvent(m.event)
        break
      case 'result':
        // Not terminal — queue:done follows with the runId.
        if (m.result) h.onResult(m.result.ok)
        break
      case 'error':
        settled = true
        h.onError(m.message ?? 'run error')
        ws.close()
        break
    }
  }
  ws.onerror = () => {
    if (!settled) h.onError('connection error')
  }
  return {
    cancel: () => {
      try {
        if (!settled && jobId !== null) {
          ws.send(JSON.stringify({ t: 'queue:cancel', v: QUEUE_PROTOCOL_VERSION, jobId }))
        }
        ws.close()
      } catch {
        // already closed
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Auth — session lifecycle (cloud-platform-2026-07 §6). The dashboard boots
// by resolving the current principal; login/register/logout re-resolve it.
// ---------------------------------------------------------------------------

/** Resolve the current session principal; throws when unauthenticated. */
async function fetchMe(): Promise<CurrentUser> {
  const res = await fetch(`${origin()}/v1/auth/me`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`me: ${res.status}`)
  const body = (await res.json()) as {
    kind: string
    userId: string
    email?: string
    displayName?: string
    instanceAdmin: boolean
    orgs: { orgId: string; role: OrgRole }[]
  }
  if (body.kind !== 'session') throw new Error('not a session principal')
  return {
    userId: body.userId,
    email: body.email ?? '',
    displayName: body.displayName ?? body.email ?? body.userId,
    instanceAdmin: body.instanceAdmin,
    orgs: body.orgs,
  }
}

/**
 * (Re-)resolve the signed-in user and reconcile the org selection. Sets
 * authState to 'authed' with the principal, or 'anon' when unauthenticated.
 * The org list (with names) is refreshed in the background for the switcher.
 */
export async function bootstrapAuth(): Promise<void> {
  try {
    const me = await fetchMe()
    setCurrentUser(me)
    reconcileOrgSelection(me.orgs.map((o) => ({ id: o.orgId })))
    setAuthState('authed')
    void refreshOrgs()
  } catch {
    setCurrentUser(null)
    setOrgs([])
    setAuthState('anon')
  }
}

export interface AuthResult {
  ok: boolean
  error?: string
}

async function authPost(pathname: string, body: Record<string, unknown>): Promise<AuthResult> {
  try {
    const res = await fetch(`${origin()}${pathname}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-vx-csrf': '1', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true }
    const j = (await res.json().catch(() => null)) as { error?: string } | null
    return { ok: false, error: j?.error ?? `request failed (${res.status})` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const r = await authPost('/v1/auth/login', { email, password })
  if (r.ok) await bootstrapAuth()
  return r
}

export async function register(args: {
  email: string
  password: string
  displayName?: string
  invite?: string
}): Promise<AuthResult> {
  const body: Record<string, unknown> = { email: args.email, password: args.password }
  if (args.displayName !== undefined && args.displayName !== '') body['displayName'] = args.displayName
  if (args.invite !== undefined && args.invite !== '') body['invite'] = args.invite
  const r = await authPost('/v1/auth/register', body)
  if (r.ok) await bootstrapAuth()
  return r
}

/** Join another org with an invite token (an already-signed-in user). */
export async function acceptInvite(invite: string): Promise<AuthResult> {
  const r = await authPost('/v1/auth/invites/accept', { invite })
  if (r.ok) await bootstrapAuth()
  return r
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${origin()}/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-vx-csrf': '1' },
    })
  } catch {
    // best-effort — the local state is cleared regardless.
  }
  setCurrentUser(null)
  setOrgs([])
  setAuthState('anon')
}

// ---------------------------------------------------------------------------
// Self-service profile — rename + change password (the /settings Profile +
// Security tabs). Both are session + CSRF; the auth routes ignore the org/ws
// clamp, so they use a direct credentialed fetch (not the analytics-scoped
// `mutate`). A successful rename re-resolves `me` so the shell updates.
// ---------------------------------------------------------------------------

async function authFetch(
  method: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<AuthResult> {
  try {
    const res = await fetch(`${origin()}${pathname}`, {
      method,
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-vx-csrf': '1', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true }
    const j = (await res.json().catch(() => null)) as { error?: string } | null
    return { ok: false, error: j?.error ?? `request failed (${res.status})` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function updateProfile(displayName: string): Promise<AuthResult> {
  const r = await authFetch('PATCH', '/v1/auth/me', { displayName })
  if (r.ok) {
    // Reflect the new name in the shell without a full reload.
    const u = currentUser()
    if (u !== null) setCurrentUser({ ...u, displayName })
  }
  return r
}

export function changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
  return authFetch('POST', '/v1/auth/password', { currentPassword, newPassword })
}

// ---------------------------------------------------------------------------
// Notifications — the bell feed: recent runs that broke (`/v1/notifications`,
// workspace-clamped). The unread badge is derived from a last-seen watermark
// persisted per origin+workspace; opening the panel marks everything seen.
// ---------------------------------------------------------------------------

export interface NotificationItem {
  kind: 'run-failed'
  runId: string
  startedAt: number
  branch: string | null
  commitSha: string | null
  failedCount: number
  taskCount: number
  /** Projects with failed tasks in the run — absent on an older serve. */
  failingProjects?: string[]
}

const NOTIF_SEEN_PREFIX = 'vx-ui:notif-seen'

function notifSeenKey(): string {
  return `${NOTIF_SEEN_PREFIX}:${origin()}|${workspace()}`
}

/** The watermark: notifications with startedAt after this are unread. */
export function getNotificationsSeenAt(): number {
  if (typeof localStorage === 'undefined') return 0
  const v = localStorage.getItem(notifSeenKey())
  return v === null ? 0 : Number(v)
}

export function markNotificationsSeen(at: number = Date.now()): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(notifSeenKey(), String(at))
}

// ---------------------------------------------------------------------------
// Pinned projects ("my projects") — the personal lens. A dev owning 2 of
// 1,800 projects stars the ones that are theirs; pins scope the Runs landing
// strip and float their runs first in the notification bell. Persisted like
// the notification watermark: per origin+workspace, this browser only.
// ---------------------------------------------------------------------------

const PINS_PREFIX = 'vx-ui:pins'

function pinsKey(): string {
  return `${PINS_PREFIX}:${origin()}|${workspace()}`
}

export function getPinnedProjects(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const v = JSON.parse(localStorage.getItem(pinsKey()) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function setPinnedProjects(pins: readonly string[]): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(pinsKey(), JSON.stringify([...new Set(pins)]))
  }
}

export async function fetchNotifications(limit = 20): Promise<NotificationItem[]> {
  // getJson applies the org/ws clamp — pass the bare path.
  const r = await getJson<{ notifications: NotificationItem[] }>(`/v1/notifications?limit=${limit}`)
  return r.notifications
}

// ---------------------------------------------------------------------------
// Admin — orgs / members / invites / tokens / workspaces (cloud-platform §6.4).
// GET reads flow through getJson (session cookie); mutations through mutate
// (CSRF header). Org id rides the PATH, so these are never `?org=`-scoped.
// ---------------------------------------------------------------------------

export interface OrgMember {
  userId: string
  email: string
  displayName: string
  role: OrgRole
}

export interface AdminToken {
  id: string
  name: string
  kind: 'ci' | 'admin'
  tier: 'trusted' | 'untrusted'
  workspaceId: string | null
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

export interface AdminWorkspace {
  id: string
  slug: string
  name: string
  createdAt: number
}

export interface CreatedInvite {
  invite: string
  url: string
  expiresAt: number
}

export interface CreatedToken {
  id: string
  token: string
}

export async function adminListOrgs(): Promise<OrgSummary[]> {
  const r = await getJson<{ orgs: OrgSummary[] }>('/v1/admin/orgs')
  return r.orgs
}

/** Refresh the org list (names) for the switcher + reconcile the selection. */
export async function refreshOrgs(): Promise<void> {
  try {
    const list = await adminListOrgs()
    setOrgs(list)
    reconcileOrgSelection(list)
  } catch {
    setOrgs([])
  }
}

export function adminCreateOrg(slug: string, name?: string): Promise<MutateResult<{ orgId: string }>> {
  return mutate('POST', '/v1/admin/orgs', { slug, ...(name !== undefined && name !== '' ? { name } : {}) })
}

export function adminUpdateOrg(
  orgId: string,
  patch: { name?: string; slug?: string },
): Promise<MutateResult<{ ok: boolean }>> {
  return mutate('PATCH', `/v1/admin/orgs/${orgId}`, patch)
}

export async function adminListMembers(orgId: string): Promise<OrgMember[]> {
  const r = await getJson<{ members: OrgMember[] }>(`/v1/admin/orgs/${orgId}/members`)
  return r.members
}

export function adminUpdateMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<MutateResult<{ ok: boolean }>> {
  return mutate('PATCH', `/v1/admin/orgs/${orgId}/members/${userId}`, { role })
}

export function adminRemoveMember(orgId: string, userId: string): Promise<MutateResult<{ ok: boolean }>> {
  return mutate('DELETE', `/v1/admin/orgs/${orgId}/members/${userId}`)
}

export function adminCreateInvite(orgId: string, role: OrgRole): Promise<MutateResult<CreatedInvite>> {
  return mutate('POST', `/v1/admin/orgs/${orgId}/invites`, { role })
}

export async function adminListTokens(orgId: string): Promise<AdminToken[]> {
  const r = await getJson<{ tokens: AdminToken[] }>(`/v1/admin/orgs/${orgId}/tokens`)
  return r.tokens
}

export function adminCreateToken(
  orgId: string,
  body: { name: string; tier: 'trusted' | 'untrusted'; kind?: 'ci' | 'admin'; workspaceId?: string },
): Promise<MutateResult<CreatedToken>> {
  return mutate('POST', `/v1/admin/orgs/${orgId}/tokens`, body)
}

export function adminRevokeToken(orgId: string, tokenId: string): Promise<MutateResult<{ ok: boolean }>> {
  return mutate('DELETE', `/v1/admin/orgs/${orgId}/tokens/${tokenId}`)
}

export async function adminListWorkspaces(orgId: string): Promise<AdminWorkspace[]> {
  const r = await getJson<{ workspaces: AdminWorkspace[] }>(`/v1/admin/orgs/${orgId}/workspaces`)
  return r.workspaces
}

export function adminCreateWorkspace(
  orgId: string,
  body: { slug: string; name?: string },
): Promise<MutateResult<{ workspaceId: string }>> {
  return mutate('POST', `/v1/admin/orgs/${orgId}/workspaces`, body)
}
