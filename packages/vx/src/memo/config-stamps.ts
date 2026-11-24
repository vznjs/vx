// Each config file as `vx lock` (or a passing `--check`) last read it, kept
// beside cache.db in `config-stamps.json`: a run reads configs only from
// `.vx/projects.lock`, so an edit with no `vx lock` after it ran the old
// config, green. Machine-local, never committed: a run asks it only while
// the lock's bytes are the ones it was taken beside, so a pull that brings
// a new lock, or a clone with no memo, asks nothing. A config edit committed
// with no `vx lock` keeps the stamped lock, so it is asked: a pull bringing
// a config with no relock is too. A failure of any kind reads as no memo: it
// is a warning light, never a requirement.

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
   * (`ProjectHookContext.read`), by project directory, workspace-relative;
   * each one's stamp is in `configs`, or none when it was absent.
   */
  reads?: Record<string, string[]>
}

interface Stamps extends ConfigStamps {
  /** The workspace they are of: a cache dir two checkouts share holds one. */
  root: string
  /** xxh3 of `.vx/projects.lock`'s bytes when taken. */
  lock: string
}

/**
 * Each config's stamp, taken before its evaluation: an edit during it reads
 * as one after. The stat before the bytes, so bytes newer than the stat
 * only ever make a run read them again.
 */
export async function takeConfigStamps(
  root: string,
  files: readonly string[],
): Promise<ConfigStamps> {
  const at = Date.now()
  const configs: ConfigStamps['configs'] = {}
  await Promise.all(
    files.map(async (file) => {
      const s = await stat(file).catch(() => null)
      const bytes = s === null ? null : await readFile(file).catch(() => null)
      if (s === null || bytes === null) return
      configs[path.relative(root, file)] = [s.size, s.mtimeMs, xxh3hex(bytes), s.ctimeMs, s.ino]
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
    await mkdir(cacheDir, { recursive: true })
    const file = path.join(cacheDir, CONFIG_STAMPS_FILE)
    const temp = `${file}.${process.pid}.tmp`
    const kept: Stamps = { root, lock, ...stamps }
    // Renamed in: a run reading beside this write sees the old file or the new.
    await writeFile(temp, JSON.stringify(kept))
    await rename(temp, file)
  } catch {
    // No memo: a run asks nothing.
  }
}

/**
 * One parse per version of the file: a run's rounds and loads ask again,
 * and a `vx watch` outlives a `vx lock` another shell runs.
 */
const read = new Map<string, { version: string; stamps: Promise<Stamps | null> }>()

async function readStamps(cacheDir: string): Promise<Stamps | null> {
  const file = path.join(cacheDir, CONFIG_STAMPS_FILE)
  const s = await stat(file).catch(() => null)
  if (s === null) return null
  const version = `${s.size}:${s.mtimeMs}:${s.ino}`
  let got = read.get(file)
  if (got?.version !== version) {
    got = {
      version,
      stamps: readFile(file, 'utf8').then(
        (text) => JSON.parse(text) as Stamps,
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
  /** The files a `project` plugin made each project's config from, by project directory. */
  reads: Record<string, string[]>
  /** Whether `rel` was there (stamped) when `vx lock` ran. */
  present: (rel: string) => boolean
  /**
   * The configs of `files` whose bytes differ from their stamp: size,
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
 * workspace; undefined when none were (a pull, a clone, another checkout's
 * cache dir).
 */
export async function stampsBesideLock(
  root: string,
  cacheDir: string,
  lock: string,
): Promise<LockStamps | undefined> {
  const stamps = await readStamps(cacheDir)
  if (stamps === null || stamps.root !== root || stamps.lock !== lock) return undefined
  const { reads, configs, at } = stamps
  if (typeof configs !== 'object' || configs === null) return undefined
  return {
    reads: typeof reads === 'object' && reads !== null ? reads : {},
    present: (rel) => Object.hasOwn(configs, rel),
    edited: async (files) => {
      const edited = await Promise.all(
        files.map(async ({ file, size, mtimeMs, ctimeMs, ino }) => {
          const rel = path.relative(root, file)
          const was = configs[rel]
          if (!Array.isArray(was)) return null
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
