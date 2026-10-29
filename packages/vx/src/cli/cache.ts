import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Cache, vxCacheEntries } from '../cache/index.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'
import {
  errorCode,
  isUserError,
  nearest,
  parseDuration,
  parseSize,
  relPosix,
  treeBytes,
  ui,
} from '../util/index.js'
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
 * it beats sending them to a help screen that lists only `clean` (walked the
 * first-run path, 2026-09-20). A typo of `clean` itself gets the same
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
  clear:
    '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  rm: '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  delete:
    '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  reset:
    '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  wipe: '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
  evict: '`vx cache clean` is the eviction verb (`--older-than`, `--max-size`)',
  gc: '`vx cache clean` is the eviction verb (`--older-than`, `--max-size`)',
  purge:
    '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it',
}

function cacheSubHint(sub: string): string {
  const elsewhere = CACHE_ELSEWHERE[sub]
  if (elsewhere !== undefined) return ` — ${elsewhere}`
  const best = nearest(sub, ['clean'])
  // `clean` is the one subcommand: name it when nothing is near (M-58).
  return best === undefined ? '. Its one subcommand is `vx cache clean`' : `. Did you mean ${best}?`
}

export async function cacheCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'clean':
      return await cleanCmd(rest)
    case undefined:
      // A bare `vx cache clean` refuses too: the hint names a whole command.
      return refuse(
        'cache',
        args,
        `missing subcommand. Try \`vx cache clean --older-than 30d\` to trim the cache, or \`vx cache clean\` to clear it${seeHelp('cache')}`,
        'VX_E_USAGE',
      )
    default:
      // `vx cache --older-than 30d` dropped the verb, not misspelled it:
      // name the clean command those flags make, when they parse as one.
      if (sub.startsWith('-') && parsePruneArgs(args).error === undefined) {
        return refuse(
          'cache',
          args,
          `missing subcommand before ${sub}. Did you mean \`vx cache clean ${args.join(' ')}\`?${seeHelp('cache')}`,
          'VX_E_USAGE',
        )
      }
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
          error: `--older-than 0 would evict every entry — \`vx cache clean\` with no bound clears the whole cache`,
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
          error: `--max-size 0 would evict every entry — \`vx cache clean\` with no bound clears the whole cache`,
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
    } else if (a === '--dry') {
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
          error: `${refusedWord(a ?? '')}: ${a}${flagHint('cache clean', a ?? '')}${seeHelp('cache')}`,
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

async function cleanCmd(args: readonly string[]): Promise<number> {
  const parsed = parsePruneArgs(args)
  if (parsed.error) return refuse('cache clean', args, parsed.error, 'VX_E_USAGE')
  const cwd = process.cwd()
  let root: string
  try {
    root = await findWorkspaceRoot(cwd)
  } catch (err) {
    return refuse('cache clean', args, (err as Error).message, errorCode(err))
  }
  // Honor `--cache-dir`, `defineWorkspace({ cacheDir: '...' })` and a
  // `config` plugin's edit of it — `vx run` and `vx cache clean` must
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
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  const facts = [
    ...(result.evicted > 0 ? [plural(result.evicted, 'entry', 'entries')] : []),
    ...(result.orphans > 0
      ? [plural(result.orphans, 'orphaned artifact', 'orphaned artifacts')]
      : []),
  ]
  ui.print(
    'out',
    freedStatus(dry, result.bytesFreed + result.orphanBytes, facts.length > 0),
    ...(facts.length > 0 ? [ui.text(facts.join(' · '))] : []),
  )
}

/** `✓ vx cache clean  freed 1.3 GB`, `› … would free 1.3 GB (dry run)`, or nothing to free. */
function freedStatus(dry: boolean, bytes: number, any: boolean): ui.Block {
  if (!any) return ui.status('info', 'vx cache clean', `nothing to free${dry ? ' (dry run)' : ''}`)
  return dry
    ? ui.status('info', 'vx cache clean', `would free ${formatBytes(bytes)} (dry run)`)
    : ui.status('ok', 'vx cache clean', `freed ${formatBytes(bytes)}`)
}

/** `vx cache clean --format json` with no bound (schemas/cache.json `clear`). */
export interface ClearResult {
  dryRun: boolean
  /** Workspace-relative inside the workspace, else absolute. */
  cleared: string[]
  bytesFreed: number
}

/**
 * `vx cache clean` with no bound: delete the cache directory (its index,
 * run history and any artifacts kept beside it) and the store its index
 * names (`~/.vx/<id>/cache`, shared by the repository's checkouts), as
 * `nx reset` does. `--global` takes every store under `~/.vx` too. The
 * workspace config, the lock and `.vx/.gitignore` sit outside them all.
 * A directory the user named (`cache.dir`) may be shared (`build/`,
 * `~/.cache`): there only what vx wrote goes (item 968).
 */
async function clear(
  args: readonly string[],
  root: string,
  dir: string,
  storeRoot: string | null,
  parsed: PruneArgs,
): Promise<number> {
  // The store the index recorded and today's (a changed HOME, an origin
  // added) both go; a directory with no index is not a vx cache to delete.
  const targets: string[] = []
  if (existsSync(path.join(dir, 'cache.db'))) {
    // An index SQLite cannot read is what its own refusal sends here to
    // clear: today's store stands in for the one it recorded.
    let store: string | undefined = storeRoot ?? undefined
    try {
      const cache = new Cache(dir, undefined, undefined, undefined, 'preview', storeRoot)
      store = cache.storeDir
      cache.close()
    } catch (err) {
      if (!isUserError(err)) throw err
    }
    targets.push(dir)
    // The index is a file in the checkout (committed, or restored from a CI
    // cache): the store it names is deleted only when it is one.
    if (store !== undefined && isStore(store)) targets.push(store)
    // Today's store too: the next run reads it, whichever store the index
    // last recorded (a moved HOME, an origin added).
    if (storeRoot !== null) targets.push(storeRoot)
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
      'cache clean',
      args,
      `cache directory ${unsafe} holds the workspace config and lock; set cache.dir to a directory of its own`,
      'VX_E_CONFIG',
    )
  }
  const dry = parsed.dryRun === true
  // `.vx/cache` and the stores are vx's own; any other directory is the
  // user's, cleared entry by entry and removed only if that empties it.
  // A `.vx/cache` linked to a volume (a CI cache mount) is emptied through
  // the link: removing the link alone left the cache where it points.
  const own = path.join(dotVx, 'cache')
  const named = path.resolve(dir) === own ? undefined : path.resolve(dir)
  const linked = named === undefined && existsSync(own) && lstatSync(own).isSymbolicLink()
  const entries = (t: string): string[] =>
    t === named
      ? vxCacheEntries(t).map((e) => path.join(t, e))
      : linked && t === own
        ? readdirSync(t).map((e) => path.join(t, e))
        : [t]
  const bytes = doomed.reduce((n, t) => n + entries(t).reduce((m, e) => m + treeBytes(e), 0), 0)
  if (!dry && doomed.length > 0) {
    // A clear beside a run deletes what the run is restoring or saving; it
    // waits for the run's lock, as a trim does.
    const release = await acquireRunLock(root, { log: warnToStderr })
    try {
      for (const t of doomed) {
        for (const e of entries(t)) rmSync(e, { recursive: true, force: true })
        if (t === named && readdirSync(t).length === 0) rmSync(t, { recursive: true })
      }
    } finally {
      await release()
    }
  }
  const shown = doomed.map((t) => (path.relative(root, t).startsWith('..') ? t : relPosix(root, t)))
  if (parsed.format === 'json') {
    const result: ClearResult = { dryRun: dry, cleared: shown, bytesFreed: bytes }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else
    ui.print(
      'out',
      freedStatus(dry, bytes, shown.length > 0),
      ...(shown.length > 0 ? [ui.text(...shown)] : []),
    )
  return 0
}

/** A store's shape: `<home>/.vx/<id>/cache` holding its `store.db`. */
function isStore(stored: string): boolean {
  const dir = path.resolve(stored)
  return (
    path.basename(dir) === 'cache' &&
    path.basename(path.dirname(path.dirname(dir))) === '.vx' &&
    existsSync(path.join(dir, 'store.db'))
  )
}
