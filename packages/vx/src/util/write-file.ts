import { lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
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
