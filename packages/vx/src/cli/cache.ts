import { Cache, noteSchemaReset } from '../cache/index.js'
import { seeHelp } from './help.js'
import { nearest, parseDuration, parseSize } from '../util/index.js'
import { acquireRunLock } from '../orchestrator/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { cliCacheDir, parseCacheDirFlag, warnToStderr } from './workspace-config.js'
import { formatBytes } from './format.js'

// parseSize moved to `util` (the orchestrator's resource resolver needs it
// and can't import cli); re-exported here so existing callers are unchanged.
export { parseDuration, parseSize } from '../util/index.js'

/**
 * `vx cache stats` is a habit from the other runners, and vx's answer is a
 * different VERB rather than a missing one — saying so where the user typed
 * it beats sending them to a help screen that lists only `prune` (walked the
 * first-run path, 2026-09-20). A typo of `prune` itself gets the same
 * nearest-neighbour hint a task, flag or project name gets.
 */
const CACHE_ELSEWHERE: Record<string, string> = {
  stats: '`vx info` reports the cache directory, its entry count and its size',
  status: '`vx info` reports the cache directory, its entry count and its size',
  size: '`vx info` reports the cache directory, its entry count and its size',
  entries: '`vx info` reports the cache directory, its entry count and its size',
  dir: '`vx info` prints the cache directory this workspace uses',
  path: '`vx info` prints the cache directory this workspace uses',
  clean: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
  clear: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
  rm: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
  delete: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
  evict: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
}

function cacheSubHint(sub: string): string {
  const elsewhere = CACHE_ELSEWHERE[sub]
  if (elsewhere !== undefined) return ` — ${elsewhere}`
  const best = nearest(sub, ['prune'])
  return best === undefined ? '' : `. Did you mean ${best}?`
}

export async function cacheCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'prune':
      return await pruneCmd(rest)
    case undefined:
      process.stderr.write('vx cache: missing subcommand. Try `vx cache prune`.\n')
      return 1
    default:
      process.stderr.write(
        `vx cache: unknown subcommand: ${sub}${cacheSubHint(sub)}${seeHelp('cache')}\n`,
      )
      return 1
  }
}

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  dryRun?: boolean
  /** `--cache-dir`: prune the cache a run with the same flag uses. */
  cacheDir?: string
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
      // A bare number is bytes to `parseSize` (a computed size needs that),
      // but nobody caps a cache at 10 bytes: `--max-size 10`
      // meant 10G or 10M and would evict everything, the same class of
      // destructive typo the zero bound above refuses. An explicit `10B`
      // still passes.
      if (/^\d+$/.test(v)) {
        return {
          error: `--max-size ${v} would read as ${v} bytes and evict nearly everything — give a unit (e.g. ${v}M, ${v}G)`,
        }
      }
      out.maxBytes = bytes
    } else if (a === '--dry-run') {
      out.dryRun = true
    } else {
      const cd = parseCacheDirFlag(args, i)
      if (cd === null) return { error: `unknown argument: ${a}${seeHelp('cache')}` }
      if ('error' in cd) return { error: cd.error }
      out.cacheDir = cd.cacheDir
      i = cd.next
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
  // Honor `--cache-dir`, `defineWorkspace({ cacheDir: '...' })` and a
  // `config` plugin's edit of it — `vx run` and `vx cache prune` must
  // operate on the same directory or prune silently no-ops against the
  // wrong path.
  const cache = new Cache(await cliCacheDir(root, parsed.cacheDir))
  // A prune deletes rows and artifacts; a cache this user cannot write is
  // refused up front with the directory named, as a run refuses it, rather
  // than dying in the first DELETE with SQLite's "readonly database" and a
  // stack (an unprivileged user on a root-owned `.vx`, 2026-09-16). A dry
  // run only reads, and reads a read-only cache fine.
  if (!parsed.dryRun) cache.assertWritable()
  noteSchemaReset(cache, warnToStderr)
  // A prune beside a run on this workspace evicts what the run has just
  // probed as hits, whose `accessed_at` bumps it has not flushed yet; the
  // run then re-runs those tasks (upstream survey, nx#36688). So a prune
  // takes the run's lock and waits its turn. A dry run deletes nothing.
  const releaseRunLock = parsed.dryRun
    ? async (): Promise<void> => {}
    : await acquireRunLock(root, { log: warnToStderr })
  try {
    const opts: { olderThanMs?: number; maxBytes?: number; dryRun?: boolean } = {}
    if (parsed.olderThanMs !== undefined) opts.olderThanMs = parsed.olderThanMs
    if (parsed.maxBytes !== undefined) opts.maxBytes = parsed.maxBytes
    if (parsed.dryRun) opts.dryRun = true
    const result = await cache.prune(opts)
    const dry = parsed.dryRun === true
    const orphans =
      result.orphans > 0
        ? `, ${dry ? 'would reap' : 'reaped'} ${result.orphans} orphaned artifact${result.orphans === 1 ? '' : 's'} (${formatBytes(result.orphanBytes)})`
        : ''
    process.stdout.write(
      `${dry ? 'Would prune' : 'Pruned'} ${result.evicted} entr${result.evicted === 1 ? 'y' : 'ies'} (${formatBytes(result.bytesFreed)}${dry ? '' : ' freed'})${orphans}\n`,
    )
  } finally {
    cache.close()
    await releaseRunLock()
  }
  return 0
}
