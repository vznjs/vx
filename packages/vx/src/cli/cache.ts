import { Cache } from '../cache/index.js'
import { seeHelp } from './help.js'
import { parseDecimalInt, parseSize } from '../util/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'
import { formatBytes } from './format.js'

// parseSize moved to `util` (the orchestrator's resource resolver needs it
// and can't import cli); re-exported here so existing callers are unchanged.
export { parseSize } from '../util/index.js'

export async function cacheCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'prune':
      return await pruneCmd(rest)
    case undefined:
      process.stderr.write('vx cache: missing subcommand. Try `vx cache prune`.\n')
      return 1
    default:
      process.stderr.write(`vx cache: unknown subcommand: ${sub}${seeHelp('cache')}\n`)
      return 1
  }
}

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs {
  const out: PruneArgs = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--older-than' || a?.startsWith('--older-than=')) {
      const v = a === '--older-than' ? args[++i] : a.slice('--older-than='.length)
      if (v === undefined || v === '') {
        return { error: `--older-than requires a value (e.g. 30d, 24h, 60m)` }
      }
      const ms = parseDuration(v)
      if (ms === null) return { error: `invalid duration: ${v}` }
      // `0d` evicts everything ever cached. That is far more often a
      // computed-to-zero retention than an intent, and no other flag
      // combination expresses "wipe the cache" — so refuse it and name
      // the deliberate way to do it.
      if (ms === 0) {
        return {
          error: `--older-than 0 would evict every entry — delete the cache directory instead`,
        }
      }
      out.olderThanMs = Date.now() - ms
    } else if (a === '--max-size' || a?.startsWith('--max-size=')) {
      const v = a === '--max-size' ? args[++i] : a.slice('--max-size='.length)
      if (v === undefined || v === '') {
        return { error: `--max-size requires a value (e.g. 500M, 1G)` }
      }
      const bytes = parseSize(v)
      if (bytes === null) return { error: `invalid size: ${v}` }
      if (bytes === 0) {
        return {
          error: `--max-size 0 would evict every entry — delete the cache directory instead`,
        }
      }
      out.maxBytes = bytes
    } else {
      return { error: `unknown argument: ${a}${seeHelp('cache')}` }
    }
  }
  if (out.olderThanMs === undefined && out.maxBytes === undefined) {
    return { error: 'must pass --older-than <duration> or --max-size <bytes>' }
  }
  return out
}

async function pruneCmd(args: readonly string[]): Promise<number> {
  const parsed = parsePruneArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx cache prune: ${parsed.error}\n`)
    return 1
  }
  const cwd = process.cwd()
  let root: string
  try {
    root = await findWorkspaceRoot(cwd)
  } catch (err) {
    process.stderr.write(`vx cache prune: ${(err as Error).message}\n`)
    return 1
  }
  // Honor `defineWorkspace({ cacheDir: '...' })` — `vx run` and
  // `vx cache prune` must operate on the same directory or prune
  // silently no-ops against the wrong path.
  const workspaceConfig = await loadWorkspaceConfig(root)
  const cache = new Cache(resolveCacheDir(root, workspaceConfig))
  try {
    const opts: { olderThanMs?: number; maxBytes?: number } = {}
    if (parsed.olderThanMs !== undefined) opts.olderThanMs = parsed.olderThanMs
    if (parsed.maxBytes !== undefined) opts.maxBytes = parsed.maxBytes
    const result = await cache.prune(opts)
    process.stdout.write(
      `Pruned ${result.evicted} entr${result.evicted === 1 ? 'y' : 'ies'} (${formatBytes(result.bytesFreed)} freed)\n`,
    )
  } finally {
    cache.close()
  }
  return 0
}

/**
 * Parse `<n><unit>` where unit is s/m/h/d, case-insensitively (`parseSize`
 * has always been case-insensitive; this matched only lowercase, so `30D`
 * was rejected while `1GB` and `1gb` both worked).
 */
export function parseDuration(input: string): number | null {
  const m = input.match(/^(\d+)([smhd])$/i)
  if (!m) return null
  const n = parseDecimalInt(m[1]!)
  if (n === null) return null
  // Lowercase before the switch: with the /i flag an uppercase `M` would
  // otherwise fall through to the days branch.
  const unit = m[2]!.toLowerCase()
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return n * mult
}
