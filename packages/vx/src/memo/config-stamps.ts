// Each config file as `vx lock` (or a passing `--check`) last read it, kept
// beside cache.db in `config-stamps.json`: a run reads configs only from
// `.vx/projects.lock`, so an edit with no `vx lock` after it ran the old
// config, green. Machine-local, never committed: a run asks it only while
// the lock's bytes are the ones it was taken beside, so a pull that brings
// a new lock, or a clone with no memo, asks nothing. A failure of any kind
// reads as no memo: it is a warning light, never a requirement.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { xxh3hex } from '../util/index.js'
import { FILE_HASH_RACY_MS, racyWindowMs } from './fs-clock.js'

const FILE = 'config-stamps.json'

interface Stamps {
  /** xxh3 of `.vx/projects.lock`'s bytes when taken. */
  lock: string
  /** When taken, epoch ms. */
  at: number
  /** Each config, workspace-relative → [size, mtimeMs, xxh3 of its bytes]. */
  configs: Record<string, [number, number, string]>
}

/** Each config's stamp, read before its evaluation: an edit during it reads as one after. */
export async function takeConfigStamps(
  root: string,
  files: readonly string[],
): Promise<Stamps['configs']> {
  const out: Stamps['configs'] = {}
  await Promise.all(
    files.map(async (file) => {
      const [s, bytes] = await Promise.all([stat(file), readFile(file)]).catch(() => [null, null])
      if (s === null || bytes === null) return
      out[path.relative(root, file)] = [s.size, s.mtimeMs, xxh3hex(bytes)]
    }),
  )
  return out
}

/** Keep `configs` beside the lock now on disk. */
export async function writeConfigStamps(
  root: string,
  cacheDir: string,
  configs: Stamps['configs'],
): Promise<void> {
  try {
    const lock = xxh3hex(await readFile(path.join(root, '.vx', 'projects.lock')))
    await mkdir(cacheDir, { recursive: true })
    const stamps: Stamps = { lock, at: Date.now(), configs }
    await writeFile(path.join(cacheDir, FILE), JSON.stringify(stamps))
  } catch {
    // No memo: a run asks nothing.
  }
}

/**
 * The configs of `files` whose bytes differ from the stamp taken beside
 * the lock whose digest is `lock`: size and mtime (the caller's stat)
 * first, the bytes only when those moved or the stamp was taken inside
 * the file's racy window (a same-size edit then keeps both). Empty when no stamp was taken beside this lock.
 */
export async function configsEditedSinceLock(
  root: string,
  cacheDir: string,
  lock: string | undefined,
  files: readonly { file: string; size: number; mtimeMs: number }[],
): Promise<string[]> {
  if (lock === undefined || files.length === 0) return []
  let stamps: Stamps
  try {
    stamps = JSON.parse(await readFile(path.join(cacheDir, FILE), 'utf8')) as Stamps
  } catch {
    return []
  }
  if (stamps.lock !== lock || typeof stamps.configs !== 'object') return []
  const edited = await Promise.all(
    files.map(async ({ file, size, mtimeMs }) => {
      const rel = path.relative(root, file)
      const was = stamps.configs[rel]
      if (!Array.isArray(was)) return null
      if (
        size === was[0] &&
        mtimeMs === was[1] &&
        stamps.at - mtimeMs > racyWindowMs(mtimeMs, FILE_HASH_RACY_MS)
      )
        return null
      const bytes = await readFile(file).catch(() => null)
      return bytes !== null && xxh3hex(bytes) !== was[2] ? rel : null
    }),
  )
  return edited.filter((f) => f !== null)
}
