import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Cache } from '../cache/index.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'
import { errorCode, nearest, parseDuration, parseSize, relPosix, treeBytes } from '../util/index.js'
import { acquireRunLock } from '../orchestrator/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import {
  cliCacheDir,
  loadCliWorkspace,
  parseCacheDirFlag,
  warnToStderr,
} from './workspace-config.js'
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
  list: '`vx info` reports the cache entry count and size, and `vx last --list` the recent runs',
  ls: '`vx info` reports the cache entry count and size, and `vx last --list` the recent runs',
  dir: '`vx info` prints the cache directory this workspace uses',
  path: '`vx info` prints the cache directory this workspace uses',
  clean:
    '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  clear:
    '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  rm: '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  delete:
    '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  reset:
    '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  wipe: '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  evict: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
  gc: '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)',
  purge:
    '`vx cache prune` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
}

function cacheSubHint(sub: string): string {
  const elsewhere = CACHE_ELSEWHERE[sub]
  if (elsewhere !== undefined) return ` — ${elsewhere}`
  const best = nearest(sub, ['prune'])
  // `prune` is the one subcommand: name it when nothing is near (M-58).
  return best === undefined ? '. The subcommand is prune' : `. Did you mean ${best}?`
}

export async function cacheCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'prune':
      return await pruneCmd(rest)
    case undefined:
      // A bare `vx cache prune` refuses too: the hint names a whole command.
      return refuse(
        'cache',
        args,
        `missing subcommand. Try \`vx cache prune --older-than 30d\` to trim the cache, or \`vx cache prune\` to clear it${seeHelp('cache')}`,
        'VX_E_USAGE',
      )
    default:
      return refuse(
        'cache',
        args,
        `unknown subcommand: ${sub}${cacheSubHint(sub)}${seeHelp('cache')}`,
        'VX_E_USAGE',
      )
  }
}

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  dryRun?: boolean
  format?: 'pretty' | 'json'
  /** `--cache-dir`: prune the cache a run with the same flag uses. */
  cacheDir?: string
  /** `--global`: clear every repository's store under `~/.vx`. */
  global?: boolean
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs {
  const out: PruneArgs = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--older-than' || a?.startsWith('--older-than=')) {
      const v = a === '--older-than' ? args[++i] : a.slice('--older-than='.length)
      if (v === undefined || v === '') {
        return {
          error: `--older-than requires a value: a duration like 30d, 24h or 60m${seeHelp('cache')}`,
        }
      }
      const ms = parseDuration(v)
      if (ms === null)
        return {
          error: `--older-than must be a duration like 30d, 24h or 60m (got ${v})${seeHelp('cache')}`,
        }
      // `0d` evicts everything ever cached. That is far more often a
      // computed-to-zero retention than an intent, and no other flag
      // combination expresses "wipe the cache" — so refuse it and name
      // the deliberate way to do it.
      if (ms === 0) {
        return {
          error: `--older-than 0 would evict every entry — \`vx cache prune\` with no bound clears the whole cache`,
        }
      }
      out.olderThanMs = Date.now() - ms
    } else if (a === '--max-size' || a?.startsWith('--max-size=')) {
      const v = a === '--max-size' ? args[++i] : a.slice('--max-size='.length)
      if (v === undefined || v === '') {
        return { error: `--max-size requires a value: a size like 500M or 1G${seeHelp('cache')}` }
      }
      const bytes = parseSize(v)
      if (bytes === null)
        return { error: `--max-size must be a size like 500M or 1G (got ${v})${seeHelp('cache')}` }
      if (bytes === 0) {
        return {
          error: `--max-size 0 would evict every entry — \`vx cache prune\` with no bound clears the whole cache`,
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
    } else if (a === '--global') {
      out.global = true
    } else if (a === '--format' || a?.startsWith('--format=')) {
      const v = formatValue(a === '--format' ? args[++i] : a.slice('--format='.length), 'cache')
      if (typeof v === 'object') return v
      out.format = v
    } else {
      const cd = parseCacheDirFlag(args, i)
      if (cd === null)
        return {
          error: `${refusedWord(a ?? '')}: ${a}${flagHint('cache prune', a ?? '')}${seeHelp('cache')}`,
        }
      if ('error' in cd) return { error: `${cd.error}${seeHelp('cache')}` }
      out.cacheDir = cd.cacheDir
      i = cd.next
    }
  }
  if (out.global === true && (out.olderThanMs !== undefined || out.maxBytes !== undefined)) {
    return {
      error: `--global clears every repository's store and takes no --older-than or --max-size${seeHelp('cache')}`,
    }
  }
  if (out.global === true && out.cacheDir !== undefined) {
    return {
      error: `--global clears the stores under ~/.vx and takes no --cache-dir${seeHelp('cache')}`,
    }
  }
  return out
}

async function pruneCmd(args: readonly string[]): Promise<number> {
  const parsed = parsePruneArgs(args)
  if (parsed.error) return refuse('cache prune', args, parsed.error, 'VX_E_USAGE')
  const cwd = process.cwd()
  let root: string
  try {
    root = await findWorkspaceRoot(cwd)
  } catch (err) {
    return refuse('cache prune', args, (err as Error).message, errorCode(err))
  }
  // Honor `--cache-dir`, `defineWorkspace({ cacheDir: '...' })` and a
  // `config` plugin's edit of it — `vx run` and `vx cache prune` must
  // operate on the same directory or prune silently no-ops against the
  // wrong path.
  // A dry run only reads: it never resets the index (item 896).
  // The store `vx run` keeps entries in (`~/.vx/<id>/cache`): with the
  // index deleted, a prune followed nothing and said 0 while every entry
  // stayed restorable (X-17).
  let dir: string
  let storeRoot: string | null = null
  if (parsed.cacheDir !== undefined) dir = await cliCacheDir(root, parsed.cacheDir)
  else {
    const ws = await loadCliWorkspace(root)
    dir = ws.cacheDir
    storeRoot = await ws.storeRoot
  }
  if (parsed.olderThanMs === undefined && parsed.maxBytes === undefined) {
    return clear(args, root, dir, storeRoot, parsed)
  }
  // A workspace that never ran has nothing to prune, and opening the cache
  // to find that out made it: `.vx/cache` with a database and a
  // `.gitignore`, where item 900 had held the dry run to making nothing
  // (and a read-only checkout was refused as unwritable instead).
  const dry = parsed.dryRun === true
  const json = parsed.format === 'json'
  if (!existsSync(dir) && (storeRoot === null || !existsSync(storeRoot))) {
    printPruned({ evicted: 0, bytesFreed: 0, orphans: 0, orphanBytes: 0 }, dry, json)
    return 0
  }
  const cache =
    parsed.dryRun === true
      ? new Cache(dir, undefined, undefined, undefined, 'preview', storeRoot)
      : new Cache(dir, undefined, root, undefined, 'open', storeRoot)
  // A prune deletes rows and artifacts; a cache this user cannot write is
  // refused up front with the directory named, as a run refuses it, rather
  // than dying in the first DELETE with SQLite's "readonly database" and a
  // stack (an unprivileged user on a root-owned `.vx`, 2026-09-16). A dry
  // run only reads, and reads a read-only cache fine.
  if (!parsed.dryRun) cache.assertWritable()
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
    printPruned(await cache.prune(opts), dry, json)
  } finally {
    cache.close()
    await releaseRunLock()
  }
  return 0
}

function printPruned(
  result: { evicted: number; bytesFreed: number; orphans: number; orphanBytes: number },
  dry: boolean,
  json: boolean,
): void {
  if (json) {
    const { evicted, bytesFreed, orphans, orphanBytes } = result
    process.stdout.write(
      `${JSON.stringify({ dryRun: dry, evicted, bytesFreed, orphans, orphanBytes })}\n`,
    )
    return
  }
  const orphans =
    result.orphans > 0
      ? `, ${dry ? 'would reap' : 'reaped'} ${result.orphans} orphaned artifact${result.orphans === 1 ? '' : 's'} (${formatBytes(result.orphanBytes)})`
      : ''
  process.stdout.write(
    `${dry ? 'Would prune' : 'Pruned'} ${result.evicted} entr${result.evicted === 1 ? 'y' : 'ies'} (${formatBytes(result.bytesFreed)}${dry ? '' : ' freed'})${orphans}\n`,
  )
}

/** `vx cache prune --format json` with no bound (schemas/cache.json `clear`). */
export interface ClearResult {
  dryRun: boolean
  /** Workspace-relative inside the workspace, else absolute. */
  cleared: string[]
  bytesFreed: number
}

/**
 * `vx cache prune` with no bound: delete the cache directory (its index,
 * run history and any artifacts kept beside it) and the store its index
 * names (`~/.vx/<id>/cache`, shared by the repository's checkouts), as
 * `nx reset` does. `--global` takes every store under `~/.vx` too. The
 * workspace config, the lock and `.vx/.gitignore` sit outside them all.
 */
async function clear(
  args: readonly string[],
  root: string,
  dir: string,
  storeRoot: string | null,
  parsed: PruneArgs,
): Promise<number> {
  // The store the index recorded wins over today's (a changed HOME), as a
  // run reads it; a directory with no index is not a vx cache to delete.
  const targets: string[] = []
  if (existsSync(path.join(dir, 'cache.db'))) {
    const cache = new Cache(dir, undefined, undefined, undefined, 'preview', storeRoot)
    const store = cache.storeDir
    cache.close()
    targets.push(dir)
    if (store !== undefined) targets.push(store)
  } else if (storeRoot !== null) targets.push(storeRoot)
  if (parsed.global === true) {
    const vxHome = path.join(process.env['HOME'] || homedir(), '.vx')
    const ids = existsSync(vxHome) ? readdirSync(vxHome) : []
    for (const id of ids) targets.push(path.join(vxHome, id, 'cache'))
  }
  // `cache.dir: '.vx'` (or the root) would take the workspace config and
  // the lock with it.
  const dotVx = path.join(root, '.vx')
  const doomed = [...new Set(targets.map((t) => path.resolve(t)))].filter((t) => existsSync(t))
  const unsafe = doomed.find((t) => t === dotVx || !path.relative(t, dotVx).startsWith('..'))
  if (unsafe !== undefined) {
    return refuse(
      'cache prune',
      args,
      `cache directory ${unsafe} holds the workspace config and lock; set cache.dir to a directory of its own`,
      'VX_E_CONFIG',
    )
  }
  const dry = parsed.dryRun === true
  const bytes = doomed.reduce((n, t) => n + treeBytes(t), 0)
  if (!dry && doomed.length > 0) {
    // A clear beside a run deletes what the run is restoring or saving; it
    // waits for the run's lock, as a trim does.
    const release = await acquireRunLock(root, { log: warnToStderr })
    try {
      for (const t of doomed) rmSync(t, { recursive: true, force: true })
    } finally {
      await release()
    }
  }
  const shown = doomed.map((t) => (path.relative(root, t).startsWith('..') ? t : relPosix(root, t)))
  if (parsed.format === 'json') {
    const result: ClearResult = { dryRun: dry, cleared: shown, bytesFreed: bytes }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else if (shown.length === 0) process.stdout.write('Nothing to clear: no cache here\n')
  else {
    const scope =
      parsed.global === true
        ? "every repository's store and this workspace's run history"
        : "this repository's store, shared by its checkouts, and this workspace's run history"
    process.stdout.write(
      `${dry ? 'Would clear' : 'Cleared'} ${scope} (${formatBytes(bytes)}${dry ? '' : ' freed'}):\n${shown.map((t) => `  ${t}\n`).join('')}`,
    )
  }
  return 0
}
