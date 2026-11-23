import { constants } from 'node:os'
import { lstatSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { UserError } from './errors.js'
import { claimExitForSignal, dieOf } from './settle.js'

/** Temps a write has made and not yet renamed or removed. */
const inFlight = new Set<string>()
let exitHooked = false

function track(tmp: string): void {
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', () => {
      for (const t of inFlight) {
        try {
          unlinkSync(t)
        } catch {
          // renamed already, or never made
        }
      }
    })
  }
  inFlight.add(tmp)
}

const STOP_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const

/**
 * `work`, with a stop signal ending vx through its exit hooks: the default
 * action skipped them, so a Ctrl-C in `vx lock` left a temp beside every
 * review copy it was writing, and `git status` offered them for commit.
 * vx still dies of the signal, as a script running it expects.
 */
export async function exitOnStop<T>(work: () => Promise<T>): Promise<T> {
  const stop = (signal: keyof typeof STOP_CODES) => (): void => {
    claimExitForSignal()
    process.once('exit', () => dieOf(signal))
    process.exit(STOP_CODES[signal])
  }
  const handlers = (Object.keys(STOP_CODES) as (keyof typeof STOP_CODES)[]).map(
    (s) => [s, stop(s)] as const,
  )
  for (const [s, h] of handlers) process.on(s, h)
  try {
    return await work()
  } finally {
    for (const [s, h] of handlers) process.off(s, h)
  }
}

/**
 * Refuses a `file` whose directory resolves outside `root`: a repo can carry
 * `.vx ->../anywhere` (or `plugins ->...`), and checking only the file's own
 * name wrote through it. The nearest directory that exists is asked; one not
 * made yet is made under it.
 */
function refuseOutside(file: string, root: string): void {
  const top = realpathSync(root)
  for (let at = path.dirname(file); ; at = path.dirname(at)) {
    let real: string
    try {
      real = realpathSync(at)
    } catch {
      // quiet: not made yet (or a dangling link mkdir cannot make through)
      if (at === path.dirname(at)) return
      continue
    }
    const rel = path.relative(top, real)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new UserError(
        `refusing to write ${file}: ${at} resolves to ${real}, outside the workspace; remove the link and run again`,
      )
    }
    return
  }
}

/**
 * Refuses a `file` that is a symlink, or whose directory resolves outside
 * `root`: a repo can carry `vx.config.ts -> /anywhere`, and a write
 * through it lands outside the workspace. Called before the first of a
 * set of writes, so a refusal leaves none half-made.
 */
export function refuseSymlink(file: string, root: string): void {
  refuseOutside(file, root)
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
  text: string | Uint8Array
  shown: string
}

/**
 * Writes each file to a temp beside it, then renames them all over their
 * names: a reader never sees half a file, and a refusal (one outside
 * `root`, as `refuseSymlink`'s) leaves every file
 * as it was, not one new beside one old (`vx lock` said it wrote nothing
 * while the config lock held the edit). A refusal names the file the user
 * knows, never its temp.
 */
export async function writeAllOrNone(files: readonly PendingWrite[], root: string): Promise<void> {
  for (const f of files) refuseOutside(f.file, root)
  const tag = `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  let at = 0
  try {
    for (; at < files.length; at++) {
      track(files[at]!.file + tag)
      await Bun.write(files[at]!.file + tag, files[at]!.text)
    }
    // A rename over a directory fails only after the ones before it landed.
    for (at = 0; at < files.length; at++)
      if ((await lstat(files[at]!.file).catch(() => null))?.isDirectory())
        throw Object.assign(new Error('directory'), { code: 'EISDIR' })
    for (at = 0; at < files.length; at++) {
      await rename(files[at]!.file + tag, files[at]!.file)
      inFlight.delete(files[at]!.file + tag)
    }
  } catch (err) {
    // Best effort: where the write was refused the temp cannot be named
    // either (ENOTDIR), and that must not replace the refusal itself.
    await Promise.all(
      files.map((f) =>
        rm(f.file + tag, { force: true })
          .catch(() => {})
          .finally(() => inFlight.delete(f.file + tag)),
      ),
    )
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
 * the check, never its target. Refused outside `root` (`refuseSymlink`).
 */
export async function writeNoFollow(file: string, text: string, root: string): Promise<void> {
  refuseSymlink(file, root)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  track(tmp)
  try {
    const fh = await open(tmp, 'wx')
    try {
      await fh.writeFile(text)
    } finally {
      await fh.close()
    }
    await rename(tmp, file)
    inFlight.delete(tmp)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    inFlight.delete(tmp)
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

interface NoReplace {
  /** 0, or -1 with `errno()` set. */
  call: (from: Buffer, to: Buffer) => number
  errno: () => number
}
let noReplace: NoReplace | null | undefined

function boundNoReplace(): NoReplace | null {
  if (noReplace !== undefined) return noReplace
  noReplace = null
  try {
    const { dlopen, FFIType, read } = require('bun:ffi') as typeof import('bun:ffi')
    const errnoAt = { args: [], returns: FFIType.ptr } as const
    if (process.platform === 'linux') {
      // glibc's soname; musl's loader answers any `libc.` name with itself.
      const { renameat2, __errno_location } = dlopen('libc.so.6', {
        renameat2: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        __errno_location: errnoAt,
      }).symbols
      noReplace = {
        // AT_FDCWD, RENAME_NOREPLACE
        call: (from, to) => renameat2(-100, from, -100, to, 1),
        errno: () => read.i32(__errno_location()!, 0),
      }
    } else if (process.platform === 'darwin') {
      const { renamex_np, __error } = dlopen('/usr/lib/libSystem.B.dylib', {
        renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __error: errnoAt,
      }).symbols
      noReplace = {
        // RENAME_EXCL
        call: (from, to) => renamex_np(from, to, 4),
        errno: () => read.i32(__error()!, 0),
      }
    }
  } catch {}
  return noReplace
}

const EEXIST = constants.errno.EEXIST
const ENOTEMPTY = constants.errno.ENOTEMPTY
// The call itself refused, by the filesystem (ZFS < 2.2, NFS, FUSE), the
// kernel or a seccomp profile: not an answer about `to`.
const UNSUPPORTED = new Set(
  ['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].map(
    (c) => (constants.errno as Record<string, number | undefined>)[c],
  ),
)

const exists = (from: string, to: string): Error =>
  Object.assign(new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`), {
    code: 'EEXIST',
  })

/**
 * Rename the directory `from` to `to` only where nothing stands at `to`;
 * EEXIST otherwise.
 * rename(2) replaces an EMPTY directory: a sibling task's fresh `mkdir -p
 * dist` was swapped for a restored tree, and its write into the directory it
 * had just resolved failed ENOENT. Where no-replace cannot be asked, `to` is
 * made as a directory and EEXIST thrown, so the caller fills it in place:
 * slower, never a clobber.
 */
export async function renameNew(from: string, to: string): Promise<void> {
  const nr = boundNoReplace()
  if (nr !== null) {
    if (nr.call(Buffer.from(`${from}\0`), Buffer.from(`${to}\0`)) === 0) return
    const errno = nr.errno()
    if (errno === EEXIST || errno === ENOTEMPTY) throw exists(from, to)
    // ENOENT, EXDEV, EACCES and the rest: rename names them as node does.
    if (!UNSUPPORTED.has(errno)) {
      await rename(from, to)
      return
    }
  }
  await mkdir(to)
  throw exists(from, to)
}
