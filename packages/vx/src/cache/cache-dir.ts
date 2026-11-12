// The cache directory itself: making it private, its ignore file, the
// manifests that say it is a cache, and the locks a clean takes.

import { Database } from 'bun:sqlite'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { closeDb } from '../index-db/index.js'
import {
  UserError,
  DOT_VX_GITIGNORE,
  IGNORE_ALL,
  isDiskFull,
  OWN_DIR_HINT,
  refuseForeignCacheDir,
} from '../util/index.js'

/**
 * The only names the orphan sweep may unlink: an artifact under a key
 * `foldKey` prints (16 lowercase hex) and the temp `tempPath` makes of
 * one. `cacheDir` is the user's to point anywhere (`build/`, a shared
 * directory), and the sweep once took any `*.tar.zst` an hour old there,
 * the user's own release tarball included.
 */
export const VX_ARTIFACT_NAME = /^([0-9a-f]{16})\.(?:tar\.zst|tree)(\.tmp-\d+-\d+-[0-9a-z]*)?$/

/** What vx writes in a cache directory besides its artifacts. */
const VX_CACHE_NAMES = new Set([
  'cache.db',
  'cache.db-wal',
  'cache.db-shm',
  'cache.db-journal',
  'cache.lock',
  // Every record vx keeps lives in cache.db, and the config bundle always
  // in `.vx/cache/compiled`, so any directory here is the user's.
])

/**
 * The entries of `cacheDir` vx wrote: the index, its artifacts, run
 * history, and the `*` ignore file unless the user changed it. A clear of
 * a directory the user named deletes these and nothing else.
 */
export function vxCacheEntries(cacheDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return []
  }
  return names.filter((name) => {
    if (VX_CACHE_NAMES.has(name) || VX_ARTIFACT_NAME.test(name)) return true
    if (name !== '.gitignore') return false
    try {
      return readFileSync(path.join(cacheDir, name), 'utf8') === IGNORE_ALL
    } catch {
      return false
    }
  })
}

/**
 * Make `cacheDir` exist and say why this process cannot write into it, or
 * `null` when it can: the directory must take new files (the WAL, the
 * artifacts) and `cache.db`, when it exists, must take pages. The file
 * system's answer, not a trial write — under WAL a rolled-back write never
 * reaches the disk, so `BEGIN IMMEDIATE … ROLLBACK` passes on a handle
 * SQLite opened read-only (proven as an unprivileged user).
 *
 * Every verb opens the cache, so each question here is one call whose
 * failure is another question's answer: `access` on the directory is also
 * "does it exist" (made only on ENOENT), `access` on the database also "is
 * it there", and the ignore file is created exclusively instead of probed
 * first. An existing cache costs three calls, it cost six, and two more
 * resolve it (`refuseForeignCacheDir`).
 */
export function openCacheDir(
  cacheDir: string,
  workspaceRoot?: string,
  index = 'cache.db',
): string | null {
  const [ignore, ignoreText] = ignoreFileFor(cacheDir)
  try {
    accessSync(cacheDir, constants.W_OK)
  } catch (err) {
    makeCacheDir(cacheDir)
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return errorText(err)
    writeIgnore(ignore, ignoreText)
    return null
  }
  try {
    accessSync(path.join(cacheDir, index), constants.W_OK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // A FILE at `cacheDir` passed the `access` above; mkdir names it.
    if (code === 'ENOTDIR') makeCacheDir(cacheDir)
    if (code !== 'ENOENT') return errorText(err)
    refuseManifestDir(cacheDir, workspaceRoot)
  }
  if (index === 'cache.db') refuseForeignCacheDir(cacheDir, workspaceRoot)
  writeIgnore(ignore, ignoreText)
  return null
}

/**
 * `openCacheDir` for the shared store: why it cannot be used, or null. Never
 * throws. `make` false asks the same question and makes or changes
 * nothing, so a reading verb settles where the entries are as a run does.
 */
export function storeBlocked(
  storeDir: string,
  storeRoot: string | null,
  make: boolean,
): string | null {
  try {
    if (storeRoot !== null) {
      // `~/.vx`, `~/.vx/<id>`, `~/.vx/<id>/cache`: owner-only, each level
      // made alone and re-checked, as Nx makes `~/.nx/<id>`. Artifacts are
      // replayed into the workspace, so nobody else may write them.
      const vxHome = path.dirname(path.dirname(storeRoot))
      for (const dir of [vxHome, path.dirname(storeRoot), storeRoot]) {
        // The levels below one not made yet are made by this user, 0700.
        if (!make && lstatSync(dir, { throwIfNoEntry: false }) === undefined)
          return mkdirBlocked(dir, false)
        const refused = ensurePrivateDir(dir, make)
        if (refused !== null) return refused
      }
    }
    if (make) return openCacheDir(storeDir, undefined, 'store.db')
    try {
      accessSync(storeDir, constants.W_OK)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return errorText(err)
      return mkdirBlocked(storeDir, true)
    }
    try {
      accessSync(path.join(storeDir, 'store.db'), constants.W_OK)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return errorText(err)
      refuseManifestDir(storeDir, undefined)
    }
    return null
  } catch (err) {
    return errorText(err)
  }
}

/** Why `mkdir` (`-p` with `recursive`) of `dir` would fail, asked without making it. */
function mkdirBlocked(dir: string, recursive: boolean): string | null {
  let up = path.dirname(dir)
  if (recursive)
    while (lstatSync(up, { throwIfNoEntry: false }) === undefined) up = path.dirname(up)
  try {
    if (!statSync(up).isDirectory()) return `${up} is not a directory`
    accessSync(up, constants.W_OK)
    return null
  } catch (err) {
    return errorText(err)
  }
}

function ensurePrivateDir(dir: string, make: boolean): string | null {
  if (make) {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return errorText(err)
    }
  }
  const st = lstatSync(dir)
  if (!st.isDirectory()) return `${dir} is not a directory`
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) return `${dir} belongs to another user`
  // One others could write may already hold what they planted (a link, an
  // entry of their own), and closing it now would keep those: not used.
  if ((st.mode & 0o022) !== 0) return `${dir} is writable by other users`
  // The user's own directory open to others (a `~/.vx` made at the
  // default umask, 0755) is vx's to close: refusing it left the store
  // unused on a stock macOS home.
  if (make && (st.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700)
    } catch (err) {
      return `${dir} is open to other users and chmod 700 failed (${errorText(err)})`
    }
  }
  return null
}

/**
 * The ignore file that keeps `cacheDir` out of git, and its text. The
 * default `.vx/cache` is named by `.vx/.gitignore` (`/cache`), committed
 * beside the workspace config and the lock; any other
 * cache directory holds a `*` one of its own. Written only when missing:
 * an existing file is the user's.
 */
function writeIgnore(file: string, text: string): void {
  try {
    writeFileSync(file, text, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

function ignoreFileFor(cacheDir: string): [string, string] {
  const parent = path.dirname(cacheDir)
  if (path.basename(cacheDir) === 'cache' && path.basename(parent) === '.vx') {
    return [path.join(parent, '.gitignore'), DOT_VX_GITIGNORE]
  }
  return [path.join(cacheDir, '.gitignore'), IGNORE_ALL]
}

/**
 * A first index in a directory that holds a manifest is a cache pointed at
 * the workspace or a project (`cacheDir: ''`, `'.'`, `'packages/a'`): the
 * `*` ignore file above hid every file in it from git, so its inputs
 * matched nothing and a changed source replayed the old output, and the
 * artifacts landed among the sources. A directory that holds
 * projects (`'packages'`) or the workspace (`'..'`, `'/'`) does the same
 * one level up. Asked only when there is no index yet, so an open cache
 * pays nothing for it.
 */
function refuseManifestDir(cacheDir: string, workspaceRoot: string | undefined): void {
  const manifestIn = (dir: string): string | undefined =>
    MANIFESTS.find((m) => existsSync(path.join(dir, m)))
  const own = manifestIn(cacheDir)
  if (own !== undefined) {
    throw new UserError(
      `cache directory ${cacheDir} holds a ${own}: it is the workspace's or a project's own ` +
        `directory, and vx would keep its index there under a \`*\` .gitignore that hides every file ` +
        `in it from git and from the cache keys. ${OWN_DIR_HINT}`,
    )
  }
  let held: string | undefined
  if (workspaceRoot !== undefined) {
    const rel = path.relative(cacheDir, workspaceRoot)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) held = workspaceRoot
  }
  if (held === undefined) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(cacheDir, entry.name)
      if (manifestIn(sub) !== undefined) {
        held = sub
        break
      }
    }
  }
  if (held !== undefined) {
    throw new UserError(
      `cache directory ${cacheDir} holds ${held}, a project or workspace directory, and vx would keep ` +
        `its index there under a \`*\` .gitignore that hides it from git and from the cache keys. ` +
        OWN_DIR_HINT,
    )
  }
}

// What marks a project or workspace directory: a vx config (workspace
// PROJECT_CONFIG_FILENAMES) or the workspace file, and a package manifest,
// which a `discover` plugin makes a project with no config.
const MANIFESTS = [
  'package.json',
  'pnpm-workspace.yaml',
  ...['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'].map((ext) => `vx.config.${ext}`),
  ...['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'].map((ext) => `.vx/workspace.${ext}`),
]

function makeCacheDir(cacheDir: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (err) {
    const where = 'set `cache.dir` in .vx/workspace.ts, or pass --cache-dir <path>'
    const code = (err as NodeJS.ErrnoException).code
    // A file at the path or at a parent of it: "make the workspace
    // writable" sent the user to chmod a tree that was writable.
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      const file = inTheWay(cacheDir)
      throw new UserError(
        `cannot create cache directory ${cacheDir}: ${file} is a file, not a directory — move it away, ${where}`,
        'VX_E_FS',
      )
    }
    // A read-only checkout with no cache yet: every verb opens the cache,
    // so this is the first thing any of them says there.
    const fix = isDiskFull(err) ? 'free space on that disk' : 'make the workspace writable'
    throw new UserError(
      `cannot create cache directory ${cacheDir} (${errorText(err)}) — vx keeps its cache there; ${fix}, ${where}`,
      'VX_E_FS',
    )
  }
}

/** The nearest of `dir` and its parents that exists, as itself (a link is not followed). */
function inTheWay(dir: string): string {
  for (let at = dir; ; at = path.dirname(at)) {
    try {
      lstatSync(at)
      return at
    } catch {
      // quiet: a missing level is the walk's question, not a fault
      if (path.dirname(at) === at) return dir
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Wait until no other connection has the shared store in `storeDir` open,
 * then hold it alone until the release. Every checkout of a repository
 * shares its store and each has a run lock of its own, so a clean in one
 * deleted store.db under a run in another. A run holds the store open from
 * its run lock to its end (never while it waits for that lock, which a
 * clean holds while it waits here), and in WAL mode every open connection keeps a
 * shared lock on the file: SQLite grants an exclusive one only to a sole
 * holder, and a holder's lock dies with its process. The run path pays
 * nothing. Holds nothing where the store has no readable file.
 */
export async function holdStore(
  storeDir: string,
  log: (line: string) => void,
): Promise<() => void> {
  const file = path.join(storeDir, 'store.db')
  if (!existsSync(file)) return () => {}
  let db: Database
  try {
    db = new Database(file)
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
  } catch {
    return () => {}
  }
  const started = performance.now()
  let said = false
  for (;;) {
    try {
      db.exec('BEGIN EXCLUSIVE')
      break
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY') {
        // Not a store SQLite reads: nothing opens it to wait for.
        closeDb(db)
        return () => {}
      }
    }
    if (!said && performance.now() - started >= 1_000) {
      said = true
      log(`[vx] waiting for another vx process using the cache store ${storeDir} to finish…`)
    }
    await Bun.sleep(50)
  }
  return () => closeDb(db)
}

/** The file in a cache directory with no store that its runs hold shared and a clean alone (`holdCacheDir`). */
const DIR_LOCK = 'cache.lock'

/**
 * Hold a cache directory with no store — `--cache-dir`, `cache.dir`,
 * `VX_CACHE_DIR`, which workspaces may share — `shared` for a run, from
 * before its cache opens to its close, or `exclusive` for `vx cache clean`,
 * waiting for the other side. Each workspace's run lock is its own, and
 * `holdStore` waits only on a store.db, so a clean in one workspace deleted
 * the directory under a run of another opening it (ENOENT on its
 * `.gitignore`, SQLite's disk I/O error). The lock is SQLite's on
 * `cache.lock` in the directory: shared and exclusive, any spelling of the
 * directory meets it, and a holder's lock dies with its process. A clean
 * deletes the file with the rest while it holds it, so a taker checks the
 * name still is the file it locked. A run finding no index yet makes the
 * directory and the file first, so the index it makes next is held; a clean
 * finding none has nothing to delete, and a directory this user cannot
 * write, or one the open refuses (`workspaceRoot`'s, as the open asks it),
 * holds nothing. A default directory beside its store pays nothing.
 */
export async function holdCacheDir(
  dir: string,
  mode: 'shared' | 'exclusive',
  log: (line: string) => void,
  signal?: AbortSignal,
  workspaceRoot?: string,
): Promise<() => void> {
  const file = path.join(dir, DIR_LOCK)
  const started = performance.now()
  let said = false
  for (;;) {
    if (signal?.aborted === true) return () => {}
    let db: Database
    let before: Stats
    try {
      let seen = statSync(file, { throwIfNoEntry: false })
      if (seen === undefined && !existsSync(path.join(dir, 'cache.db'))) {
        if (mode === 'exclusive') return () => {}
        // The run makes the index next: unheld, a clean in another workspace
        // deleted it under the run, which ended green with its entry gone.
        // A directory that was there may be one the open refuses a first
        // index in (a project's own): its refusal, thrown here, writes
        // nothing, and the open throws it again.
        if (mkdirSync(dir, { recursive: true }) === undefined) {
          refuseManifestDir(dir, workspaceRoot)
          refuseForeignCacheDir(dir, workspaceRoot)
        }
      }
      if (seen === undefined) {
        // Made before it is stat'ed: a file Database creates is not the one
        // a stat before it saw.
        writeFileSync(file, '', { flag: 'a' })
        seen = statSync(file)
      }
      before = seen
      db = new Database(file)
      db.exec('PRAGMA busy_timeout = 0')
    } catch {
      return () => {}
    }
    try {
      if (mode === 'exclusive') db.exec('BEGIN EXCLUSIVE')
      else {
        db.exec('BEGIN')
        db.query('SELECT count(*) FROM sqlite_master').get()
      }
      const now = statSync(file, { throwIfNoEntry: false })
      if (now !== undefined && now.ino === before.ino && now.dev === before.dev) {
        return () => closeDb(db)
      }
      // A clean deleted it while this waited: take the one there now.
      closeDb(db)
      continue
    } catch (err) {
      closeDb(db)
      if ((err as { code?: string }).code !== 'SQLITE_BUSY') return () => {}
    }
    if (!said && performance.now() - started >= 1_000) {
      said = true
      log(
        mode === 'exclusive'
          ? `[vx] waiting for another vx process using the cache directory ${dir} to finish…`
          : `[vx] waiting for a vx cache clean of ${dir} to finish…`,
      )
    }
    await Bun.sleep(50)
  }
}
