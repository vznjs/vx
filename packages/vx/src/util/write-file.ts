import { lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { UserError } from './errors.js'

/**
 * Refuses a `file` that is a symlink: a repo can carry `vx.config.ts ->
 * /anywhere`, and a write through it lands outside the workspace. Called
 * before the first of a set of writes, so a refusal leaves none half-made.
 */
export function refuseSymlink(file: string): void {
  let link: string
  try {
    if (!lstatSync(file).isSymbolicLink()) return
    link = readlinkSync(file)
  } catch {
    // quiet: nothing there to write through
    return
  }
  throw new UserError(
    `refusing to write ${file}: it is a symlink to ${link}; remove the link and run again`,
  )
}

/**
 * A rename over a directory (EISDIR) as a refusal naming `shown`, not a
 * stack trace; any other error as it was.
 */
function directoryInTheWay(err: unknown, shown: string): unknown {
  return (err as NodeJS.ErrnoException | null)?.code === 'EISDIR'
    ? new UserError(`cannot write ${shown}: a directory stands there; remove it and run again`)
    : err
}

/** A file to write: its path, its bytes, and the name a refusal shows. */
export interface PendingWrite {
  file: string
  text: string
  shown: string
}

/**
 * Writes each file to a temp beside it, then renames them all over their
 * names: a reader never sees half a file, and a refusal leaves every file
 * as it was, not one new beside one old (`vx lock` said it wrote nothing
 * while the config lock held the edit). A refusal names the file the user
 * knows, never its temp.
 */
export async function writeAllOrNone(files: readonly PendingWrite[]): Promise<void> {
  const tag = `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  let at = 0
  try {
    for (; at < files.length; at++) await Bun.write(files[at]!.file + tag, files[at]!.text)
    // A rename over a directory fails only after the ones before it landed.
    for (at = 0; at < files.length; at++)
      if ((await lstat(files[at]!.file).catch(() => null))?.isDirectory())
        throw Object.assign(new Error('directory'), { code: 'EISDIR' })
    for (at = 0; at < files.length; at++) await rename(files[at]!.file + tag, files[at]!.file)
  } catch (err) {
    // Best effort: where the write was refused the temp cannot be named
    // either (ENOTDIR), and that must not replace the refusal itself.
    await Promise.all(files.map((f) => rm(f.file + tag, { force: true }).catch(() => {})))
    const f = files[Math.min(at, files.length - 1)]!
    const e = err as NodeJS.ErrnoException
    if (typeof e.message === 'string') e.message = e.message.split(f.file + tag).join(f.file)
    if (e.path === f.file + tag) e.path = f.file
    throw directoryInTheWay(err, f.shown)
  }
}

/**
 * Writes `text` to `file`, never through a link: a temp beside it, made
 * with O_EXCL, renamed over it. A rename replaces a link put there after
 * the check, never its target.
 */
export async function writeNoFollow(file: string, text: string): Promise<void> {
  refuseSymlink(file)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    const fh = await open(tmp, 'wx')
    try {
      await fh.writeFile(text)
    } finally {
      await fh.close()
    }
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    // The refusal names the file the user knows, as `writeLockfile`'s does.
    const e = err as NodeJS.ErrnoException
    if (typeof e.message === 'string') e.message = e.message.split(tmp).join(file)
    if (e.path === tmp) e.path = file
    throw err
  }
}

/** A `.gitignore` that hides its whole directory from git, itself included. */
export const IGNORE_ALL = '*\n'

/**
 * Hides `dir`, a directory vx made, from git: an `IGNORE_ALL` `.gitignore`
 * in it (the Cargo / Nx convention), written only when absent, so a
 * user's own file wins. Never trusts a `.vx/.gitignore` to name it: an
 * older init's, a user's own, or a cache moved elsewhere names none.
 */
export function ignoreDir(dir: string): void {
  try {
    writeFileSync(path.join(dir, '.gitignore'), IGNORE_ALL, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}
