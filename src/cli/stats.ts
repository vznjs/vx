import path from 'node:path'
import { Cache, type CacheStats } from '../cache/cache.js'
import { findWorkspaceRoot } from '../workspace/workspace.js'
import { formatBytes } from './format.js'

export async function statsCmd(): Promise<number> {
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
    process.stdout.write(formatStats(cache.stats()))
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
