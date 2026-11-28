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
  readlinkSync,
  type Stats,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { closeDb } from '../index-db/index.js'
import {
  DOT_VX_GITIGNORE,
  IGNORE_ALL,
  isDiskFull,
  lstatOrAbsent,
  OWN_DIR_HINT,
  refuseForeignCacheDir,
  statOrAbsent,
  UserError,
} from '../util/index.js'

/**
 * The only names the orphan sweep may unlink: a 16-hex artifact and its temp.
 * `cacheDir` may point anywhere (`build/`), so any other `*.tar.zst` there is
 * the user's.
 */
export const VX_ARTIFACT_NAME = /^([0-9a-f]{16})\.(?:tar\.zst|tree)(\.tmp-\d+-\d+-[0-9a-z]*)?$/

/** The file in a cache directory with no store that its runs hold shared and a clean alone (`holdCacheDir`). */
const DIR_LOCK = 'cache.lock'

/**
 * `vx lock`'s config stamps, which no vx writes since 2026-11-25, and a temp
 * of them a crash left: still vx's, so a clear of a named dir removes them.
 */
const OLD_STAMPS = /^config-stamps\.json(\.\d+\.tmp)?$/

/** What vx writes in a cache directory besides its artifacts. */
const VX_CACHE_NAMES = new Set([
  'cache.db',
  'cache.db-wal',
  'cache.db-shm',
  'cache.db-journal',
  DIR_LOCK,
  // Every other record vx keeps lives in cache.db, and the config bundle
  // always in `.vx/cache/compiled`, so any directory here is the user's.
])

/**
 * The entries of `cacheDir` vx wrote. A clear of a directory the user named
 * deletes these and nothing else. The lock is listed last: a clear deletes in
 * this order, and a run waiting on it takes a missing lock as the clear's end
 * (`holdCacheDir`). Deleted before `cache.db`, the run opened an index the
 * clear then took.
 */
export function vxCacheEntries(cacheDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return []
  }
  const own = names.filter((name) => {
    if (name === DIR_LOCK) return false
    if (VX_CACHE_NAMES.has(name) || VX_ARTIFACT_NAME.test(name) || OLD_STAMPS.test(name))
      return true
    if (name !== '.gitignore') return false
    try {
      return readFileSync(path.join(cacheDir, name), 'utf8') === IGNORE_ALL
    } catch {
      return false
    }
  })
  return names.includes(DIR_LOCK) ? [...own, DIR_LOCK] : own
}

/**
 * Make `cacheDir` exist and say why this process cannot write it, or `null`:
 * the directory must take new files and `cache.db` must take pages. The file
 * system's answer, not a trial write: under WAL a rolled-back write never
 * reaches disk, so it passes on a read-only handle.
 *
 * Each call's failure answers another question (`access` on the directory is
 * also "does it exist", the ignore file is created exclusively), so an existing
 * cache costs three calls.
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
 * Make `cacheDir` and its ignore file before any index opens (`vx watch`'s
 * clock): made bare, `.vx/cache/` was left for `git add -A` to commit. A `*` goes into
 * a named directory only when this made it: one that stood may be the user's,
 * and `openCacheDir` checks it first.
 */
export function makeIgnoredCacheDir(cacheDir: string): void {
  const [ignore, ignoreText] = ignoreFileFor(cacheDir)
  const made = !existsSync(cacheDir)
  makeCacheDir(cacheDir)
  if (made || ignore !== path.join(cacheDir, '.gitignore')) writeIgnore(ignore, ignoreText)
}

/**
 * `openCacheDir` for the shared store: why it cannot be used, or null. Never
 * throws. `make` false makes nothing, so a reading verb settles where entries
 * are as a run does.
 */
export function storeBlocked(
  storeDir: string,
  storeRoot: string | null,
  make: boolean,
): string | null {
  try {
    if (storeRoot !== null) {
      // `~/.vx`, `~/.vx/<id>`, `~/.vx/<id>/cache`: owner-only, each made alone
      // and re-checked, as Nx makes `~/.nx/<id>`. Artifacts are replayed into
      // the workspace, so nobody else may write them.
      const vxHome = path.dirname(path.dirname(storeRoot))
      for (const dir of [vxHome, path.dirname(storeRoot), storeRoot]) {
        // The levels below one not made yet are made by this user, 0700.
        if (!make && lstatOrAbsent(dir) === undefined) return mkdirBlocked(dir, false)
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
  if (recursive) while (lstatOrAbsent(up) === undefined) up = path.dirname(up)
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
  // The user's own directory open to others (made at umask 0755) is vx's to
  // close, or the store goes unused on a stock macOS home.
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
 * The ignore file that keeps `cacheDir` out of git. The default `.vx/cache` is
 * named by the committed `.vx/.gitignore`; any other cache directory holds its
 * own `*`. Written only when missing.
 */
function writeIgnore(file: string, text: string): void {
  try {
    writeFileSync(file, text, { flag: 'wx' })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EEXIST') return
    // `wx` made it before the write was refused: an empty one would stand
    // as "written" to every later run.
    rmSync(file, { force: true })
    // Bun's refused `write` names no path, so the line said "the disk that
    // path is on is full" with no path in it.
    if (e.path === undefined) {
      e.path = file
      e.message = `${e.message} '${file}'`
    }
    throw err
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
 * A first index in a directory holding a manifest is a cache pointed at the
 * workspace or a project: its `*` ignore file would hide every source from git,
 * so inputs match nothing and stale output replays. A directory holding
 * projects or the workspace is refused too. Asked only when there is no index
 * yet.
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
  // A folder of the workspace's own files (`--cache-dir src`): its `*` would
  // hide them as surely. One that already holds a .gitignore is the user's
  // or vx's own choice, and one outside the workspace hides nothing a key reads.
  if (
    held === undefined &&
    workspaceRoot !== undefined &&
    ignoreFileFor(cacheDir)[1] === IGNORE_ALL
  ) {
    const rel = path.relative(workspaceRoot, cacheDir)
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const all = readdirSync(cacheDir)
      const names = all.filter((n) => !VX_OWN.has(n))
      if (names.length > 0 && !all.includes('.gitignore')) {
        const shown = names.sort().slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
        throw new UserError(
          `cache directory ${cacheDir} holds ${shown}: a \`*\` .gitignore there would hide ` +
            `${names.length === 1 ? 'it' : 'them'} from git and from the cache keys. ${OWN_DIR_HINT}`,
        )
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

// What vx itself leaves in a cache directory before or beside its index.
const VX_OWN = new Set([DIR_LOCK, 'cache.db', 'cache.db-wal', 'cache.db-shm', 'compiled'])

// What marks a project or workspace directory: a vx config, the workspace file,
// or a package manifest.
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
      // A link to nothing is no file: "move it away" sent the user hunting.
      const what = lstatOrAbsent(file)?.isSymbolicLink()
        ? `a link to ${readlinkSync(file)}, ${linkEnd(file)}`
        : 'a file, not a directory'
      throw new UserError(
        `cannot create cache directory ${cacheDir}: ${file} is ${what} — move it away, ${where}`,
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

/** What a link in the cache dir's way ends at; a loop of links is no crash (ELOOP). */
function linkEnd(link: string): string {
  try {
    return statOrAbsent(link) === undefined ? 'which is not there' : 'not a directory'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOOP') throw err
    return 'which loops back through links and never ends'
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
 * Wait until no other connection has the shared store open, then hold it alone
 * until release: each checkout has its own run lock, so a clean in one could
 * delete store.db under a run in another. A run holds the store open from its
 * run lock to its end, and in WAL every connection keeps a shared lock: SQLite
 * grants an exclusive one only to a sole holder. The run path pays nothing.
 */
export async function holdStore(
  storeDir: string,
  log: (line: string) => void,
): Promise<() => void> {
  const file = path.join(storeDir, 'store.db')
  if (!existsSync(file)) return () => {}
  const started = performance.now()
  let said = false
  for (;;) {
    let db: Database
    try {
      // Never made here: a clean that won the store deletes it, and this
      // one then has nothing to wait for.
      db = new Database(file, { readwrite: true, create: false })
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('PRAGMA locking_mode = EXCLUSIVE')
    } catch {
      return () => {}
    }
    try {
      db.exec('BEGIN EXCLUSIVE')
      return () => closeDb(db)
    } catch (err) {
      // Closed before the next try: in exclusive locking mode a failed try
      // keeps the shared lock it got, so two cleans waiting on one run each
      // still saw the other once the run closed, and waited forever.
      closeDb(db)
      // Not a store SQLite reads: nothing opens it to wait for.
      if ((err as { code?: string }).code !== 'SQLITE_BUSY') return () => {}
    }
    if (!said && performance.now() - started >= 1_000) {
      said = true
      log(`[vx] waiting for another vx process using the cache store ${storeDir} to finish…`)
    }
    // Jittered: two waiters trying in step would each meet the other's try.
    await Bun.sleep(25 + Math.random() * 50)
  }
}

/**
 * Hold a cache directory with no store (`--cache-dir`, `cache.dir`,
 * `VX_CACHE_DIR`, which workspaces may share): `shared` for a run, from before
 * its cache opens to its close, or `exclusive` for `vx cache clean`. The lock
 * is SQLite's on `cache.lock` in the directory, so any spelling meets it and it
 * dies with its process. A clean deletes the file it holds, so a taker checks
 * the name is still the file it locked. A run finding no index makes the
 * directory and file first. A default directory beside its store pays nothing.
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
      let seen = statOrAbsent(file)
      if (seen === undefined && !existsSync(path.join(dir, 'cache.db'))) {
        if (mode === 'exclusive') return () => {}
        // The run makes the index next and must hold it, or a clean elsewhere
        // deletes it under the run. A directory the open refuses a first index
        // in throws here, writing nothing.
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
      const now = statOrAbsent(file)
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
