// Each config file as `vx lock` (or a passing `--check`, or a run that
// evaluated it) last read it, kept beside cache.db in `config-stamps.json`:
// a run reads configs only from `.vx/projects.lock`, so an edit with no
// `vx lock` after it ran the old config, green. Machine-local, never
// committed. Kept per workspace and lock digest, the last `KEPT` used: a
// branch checked out again finds its lock's stamps. A lock with none (a
// pull, a clone, a branch another `vx lock` left) has its configs evaluated
// once by the run, as `vx lock --check` does (orchestrator/projects.ts),
// and stamped then. A config edit committed with no `vx lock` keeps the
// stamped lock, so it is asked. A memo that fails to read reads as none.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { xxh3hex } from '../util/index.js'
import { FILE_HASH_RACY_MS, racyWindowMs } from './fs-clock.js'

/** The file in a cache directory the stamps live in; a clear deletes it (and a temp of it). */
export const CONFIG_STAMPS_FILE = 'config-stamps.json'

/** Each config as `takeConfigStamps` read it. */
export interface ConfigStamps {
  /** Epoch ms before the first stat: the racy window runs from here. */
  at: number
  /**
   * Each config, workspace-relative → [size, mtimeMs, xxh3 of its bytes,
   * ctimeMs, inode]. Size and mtime alone missed a same-length edit whose
   * mtime was set back; ctime and the inode move with any write, as in
   * the file-hash memo. A stamp from before them has neither: its bytes
   * are read.
   */
  configs: Record<string, [number, number, string, number?, number?]>
  /**
   * The files a `project` plugin made each project's config from
   * (`ProjectHookContext.read`) and the files its config imports, by project
   * directory, workspace-relative; each one's stamp is in `configs`, or none
   * when it was absent.
   */
  reads?: Record<string, string[]>
  /**
   * `reads` holds each config's local imports too (`configImports`). Stamps
   * an older vx took hold none, so they read as no stamps: a helper a
   * config imports, edited with no `vx lock`, ran the locked config, green.
   */
  imports?: true
}

interface Stamps extends ConfigStamps {
  /** The workspace they are of: a cache dir two checkouts share holds both. */
  root: string
  /** xxh3 of `.vx/projects.lock`'s bytes when taken. */
  lock: string
}

/** The file: each workspace's and lock's stamps, the last used first. */
interface StampsFile {
  entries: Stamps[]
}

/** How many locks' stamps the file keeps: a few branches checked out in turn. */
const KEPT = 8

/**
 * Each config's stamp, taken before its evaluation: an edit during it reads
 * as one after. The stat before the bytes, so bytes newer than the stat
 * only ever make a run read them again. `bytes` gets each file's bytes as
 * read, for a caller that scans them next.
 */
export async function takeConfigStamps(
  root: string,
  files: readonly string[],
  bytes?: Map<string, Uint8Array>,
): Promise<ConfigStamps> {
  const at = Date.now()
  const configs: ConfigStamps['configs'] = {}
  await Promise.all(
    files.map(async (file) => {
      const s = await stat(file).catch(() => null)
      const got = s === null ? null : await readFile(file).catch(() => null)
      if (s === null || got === null) return
      bytes?.set(file, got)
      configs[path.relative(root, file)] = [s.size, s.mtimeMs, xxh3hex(got), s.ctimeMs, s.ino]
    }),
  )
  return { at, configs }
}

/** Keep `stamps` beside the lock now on disk. */
export async function writeConfigStamps(
  root: string,
  cacheDir: string,
  stamps: ConfigStamps,
): Promise<void> {
  try {
    const lock = xxh3hex(await readFile(path.join(root, '.vx', 'projects.lock')))
    await keep(cacheDir, { root, lock, ...stamps, imports: true }, true)
  } catch {
    // No memo: the next run evaluates the configs.
  }
}

/**
 * Keep `taken` beside lock `lock`: a run found those configs and mapped-from
 * files to evaluate as the lock holds. Taken by the caller before it
 * evaluated: an edit between the two reads as one after. The lock's other
 * stamps and `at` stay; a lock with none gets these. Only into a cache dir
 * a run or `vx lock` made: a plan makes none (`clockDir`), so until one
 * exists each run evaluates again.
 */
export async function restampConfigs(
  root: string,
  cacheDir: string,
  lock: string,
  taken: ConfigStamps,
): Promise<void> {
  try {
    const was = (await readStamps(cacheDir))?.entries.find(
      (e) => e.root === root && e.lock === lock,
    )
    await keep(
      cacheDir,
      // Marked as holding imports: a lock whose stamps held none was
      // evaluated whole (`stampsBesideLock`) before this restamp.
      was === undefined
        ? { root, lock, ...taken, imports: true }
        : {
            ...was,
            configs: { ...was.configs, ...taken.configs },
            reads: { ...was.reads, ...taken.reads },
            imports: true,
          },
      false,
    )
  } catch {
    // No memo: the next run evaluates again.
  }
}

/**
 * `entry` first, replacing its workspace's and lock's, the rest after it up
 * to `KEPT`. Without `make`, no cache dir fails the write.
 */
async function keep(cacheDir: string, entry: Stamps, make: boolean): Promise<void> {
  const others = ((await readStamps(cacheDir))?.entries ?? []).filter(
    (e) => e.root !== entry.root || e.lock !== entry.lock,
  )
  if (make) await mkdir(cacheDir, { recursive: true })
  const file = path.join(cacheDir, CONFIG_STAMPS_FILE)
  const temp = `${file}.${process.pid}.tmp`
  const out: StampsFile = { entries: [entry, ...others].slice(0, KEPT) }
  // Renamed in: a run reading beside this write sees the old file or the new.
  await writeFile(temp, JSON.stringify(out))
  await rename(temp, file)
}

/**
 * One parse per version of the file: a run's rounds and loads ask again,
 * and a `vx watch` outlives a `vx lock` another shell runs.
 */
const read = new Map<string, { version: string; stamps: Promise<StampsFile | null> }>()

async function readStamps(cacheDir: string): Promise<StampsFile | null> {
  const file = path.join(cacheDir, CONFIG_STAMPS_FILE)
  const s = await stat(file).catch(() => null)
  if (s === null) return null
  const version = `${s.size}:${s.mtimeMs}:${s.ino}`
  let got = read.get(file)
  if (got?.version !== version) {
    got = {
      version,
      stamps: readFile(file, 'utf8').then(
        (text) => {
          const parsed = JSON.parse(text) as Partial<StampsFile> | null
          return Array.isArray(parsed?.entries) ? { entries: parsed.entries } : null
        },
        () => null,
      ),
    }
    read.set(file, got)
  }
  return got.stamps.catch(() => null)
}

/** A config as the caller stat'ed it, for `LockStamps.edited`. */
export interface ConfigStat {
  readonly file: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly ino: number
}

/** The stamps `vx lock` took beside one lock, read once (one stat) per load. */
export interface LockStamps {
  /**
   * The files a `project` plugin made each project's config from, and the
   * files its config imports, by project directory.
   */
  reads: Record<string, string[]>
  /** Whether `rel` was there (stamped) when `vx lock` ran. */
  present: (rel: string) => boolean
  /**
   * The configs of `files` whose bytes differ from their stamp, or that
   * have none: size,
   * mtime, ctime and inode (the caller's stat) first, the bytes only when
   * those moved or the
   * stamp was taken inside the file's racy window (a same-size edit then
   * keeps both). A commit since changes nothing: a config it moved under
   * the same lock was not relocked.
   */
  edited: (files: readonly ConfigStat[]) => Promise<string[]>
}

/**
 * The stamps taken beside the lock whose digest is `lock` in this
 * workspace; undefined when none were (a pull, a clone, a branch another
 * `vx lock` left), or they hold no imports: the run then evaluates every
 * config it reads.
 */
export async function stampsBesideLock(
  root: string,
  cacheDir: string,
  lock: string,
): Promise<LockStamps | undefined> {
  const stamps = (await readStamps(cacheDir))?.entries.find(
    (e) => e?.root === root && e.lock === lock,
  )
  if (stamps === undefined || stamps.imports !== true) return undefined
  const { reads, configs, at } = stamps
  if (typeof configs !== 'object' || configs === null) return undefined
  return {
    reads: typeof reads === 'object' && reads !== null ? reads : {},
    present: (rel) => Object.hasOwn(configs, rel),
    edited: async (files) => {
      const edited = await Promise.all(
        files.map(async ({ file, size, mtimeMs, ctimeMs, ino }) => {
          const rel = path.relative(root, file)
          // None: a run stamped only the configs it evaluated beside this lock.
          const was = Object.hasOwn(configs, rel) ? configs[rel] : undefined
          if (!Array.isArray(was)) return rel
          if (
            size === was[0] &&
            mtimeMs === was[1] &&
            ctimeMs === was[3] &&
            ino === was[4] &&
            at - mtimeMs > racyWindowMs(mtimeMs, FILE_HASH_RACY_MS)
          )
            return null
          const bytes = await readFile(file).catch(() => null)
          return bytes !== null && xxh3hex(bytes) !== was[2] ? rel : null
        }),
      )
      return edited.filter((f) => f !== null)
    },
  }
}
