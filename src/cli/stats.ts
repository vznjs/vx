import path from 'node:path'
import { Cache, type CacheStats } from '../cache/cache.js'
import { findWorkspaceRoot } from '../workspace/workspace.js'
import { formatBytes } from './format.js'

export interface StatsArgs {
  json: boolean
  error?: string
}

export function parseStatsArgs(args: readonly string[]): StatsArgs {
  const out: StatsArgs = { json: false }
  for (const a of args) {
    if (a === '--json') {
      out.json = true
    } else {
      return { ...out, error: `unknown argument: ${a}` }
    }
  }
  return out
}

export async function statsCmd(args: readonly string[] = []): Promise<number> {
  const parsed = parseStatsArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx stats: ${parsed.error}\n`)
    return 1
  }

  const cwd = process.cwd()
  let root: string
  try {
    root = await findWorkspaceRoot(cwd)
  } catch (err) {
    process.stderr.write(`vx stats: ${(err as Error).message}\n`)
    return 1
  }
  const cache = new Cache(path.join(root, '.vx', 'cache'))
  try {
    const stats = cache.stats()
    process.stdout.write(parsed.json ? formatStatsJson(stats) : formatStats(stats))
  } finally {
    cache.close()
  }
  return 0
}

export function formatStats(s: CacheStats): string {
  const hitRate =
    s.runCountLast24h > 0 ? `${((s.hitCountLast24h / s.runCountLast24h) * 100).toFixed(1)}%` : 'n/a'
  return [
    'Cache statistics',
    '----------------',
    `Entries:           ${s.entryCount}`,
    `Total size:        ${formatBytes(s.totalBytes)}`,
    `Runs (24h):        ${s.runCountLast24h}`,
    `Hits  (24h):       ${s.hitCountLast24h}  (${hitRate})`,
    '',
  ].join('\n')
}

export function formatStatsJson(s: CacheStats): string {
  // Numbers only, no formatted strings — consumers do the rendering.
  // hitRateLast24h is null (not 0) when there's no denominator, so
  // `0%` and "we don't know" stay distinguishable.
  const hitRateLast24h = s.runCountLast24h > 0 ? s.hitCountLast24h / s.runCountLast24h : null
  return (
    JSON.stringify(
      {
        entryCount: s.entryCount,
        totalBytes: s.totalBytes,
        runCountLast24h: s.runCountLast24h,
        hitCountLast24h: s.hitCountLast24h,
        hitRateLast24h,
      },
      null,
      2,
    ) + '\n'
  )
}
