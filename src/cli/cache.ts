import { Cache } from '../cache/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'
import { formatBytes } from './format.js'

export async function cacheCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'prune':
      return await pruneCmd(rest)
    case undefined:
      process.stderr.write('vx cache: missing subcommand. Try `vx cache prune`.\n')
      return 1
    default:
      process.stderr.write(`vx cache: unknown subcommand: ${sub}\n`)
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
    if (a === '--older-than') {
      const v = args[++i]
      if (v === undefined) return { error: `${a} requires a value (e.g. 30d, 24h, 60m)` }
      const ms = parseDuration(v)
      if (ms === null) return { error: `invalid duration: ${v}` }
      out.olderThanMs = Date.now() - ms
    } else if (a === '--max-size') {
      const v = args[++i]
      if (v === undefined) return { error: `${a} requires a value (e.g. 500M, 1G)` }
      const bytes = parseSize(v)
      if (bytes === null) return { error: `invalid size: ${v}` }
      out.maxBytes = bytes
    } else {
      return { error: `unknown argument: ${a}` }
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

export function parseDuration(input: string): number | null {
  const m = input.match(/^(\d+)([smhd])$/)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return n * mult
}

export function parseSize(input: string): number | null {
  const m = input.match(/^(\d+)([KMGT])?B?$/i)
  if (!m) return null
  const n = Number(m[1])
  const u = (m[2] ?? '').toUpperCase()
  const mult =
    u === '' ? 1 : u === 'K' ? 1024 : u === 'M' ? 1024 * 1024 : u === 'G' ? 1024 ** 3 : 1024 ** 4
  return n * mult
}
