export interface OverviewResponse {
  cache: {
    entryCount: number
    totalBytes: number
    runCountLast24h: number
    hitCountLast24h: number
    hitRateLast24h: number | null
  }
  recentRuns: RunSummary[]
}

export interface RunSummary {
  runId: string
  startedAt: number
  endedAt: number
  durationMs: number
  taskCount: number
  successCount: number
  cacheHitCount: number
  failedCount: number
}

export interface SlowestTask {
  project: string
  task: string
  avgDurationMs: number
  maxDurationMs: number
  runCount: number
}

export interface CacheEntryRow {
  hash: string
  project: string
  task: string
  sizeBytes: number
  createdAt: number
  accessedAt: number
  exitCode: number
  durationMs: number
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return (await res.json()) as T
}
