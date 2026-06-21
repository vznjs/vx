// HTTP client for the vx serve insights API. Same shape locally or
// against a remote/hosted vx serve — the SPA is platform-agnostic.
//
// The base URL is resolved from the connection store; that store
// persists the user's choice to localStorage and defaults to
// http://localhost:4321 (vx serve's chosen origin lives in
// `.vx/serve.json`, but the SPA can't read disk — the user pastes
// the printed origin in, or accepts the default).

import { createSignal } from 'solid-js'

const STORAGE_KEY = 'vx-insights:origin'

function defaultOrigin(): string {
  // `vx insights` injects this at dev time; the hosted build falls back
  // to the user choosing via the connection picker.
  const injected = import.meta.env.VITE_DEFAULT_ORIGIN
  if (typeof injected === 'string' && injected.length > 0) return injected
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
// Types — mirror src/orchestrator/insights-queries.ts return shapes.
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
  runs: number
  successRate: number
  hitRate: number
  failureMode: 'stable' | 'flaky-recoverable' | 'flaky-fatal'
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
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
