// .vx/projects.lock.json — frozen resolved-config lockfile.
//
// `vx lock` finds every project's vx.config.*, evaluates each in the
// CURRENT environment and freezes the resolved objects, by directory, into
// `.vx/projects.lock.json` at the workspace root. Every run loads configs from
// it and never evaluates one (2026-10-14); only `vx lock` writes
// it. See docs/design/config-lock-2026-06.md.
//
// Verification asymmetry (deliberate):
//   - runs TRUST the lock: no staleness check, no schema validation,
//     eval-free.
//   - `vx lock --check` AUDITS it: full re-evaluation + deep equality.

import { readFileSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import { keysSorted, relPosix, UserError, xxh3, xxh3hex } from '../util/index.js'
import { VERSION } from '../version.js'
import { validateProjectConfig } from './config-schema.js'
import { PROJECT_CONFIG_FILENAMES } from './workspace.js'

export const LOCKFILE_NAME = '.vx/projects.lock.json'
export const LOCKFILE_VERSION = 4

/** One project as the lock holds it. */
export interface LockedProject {
  /** The config file's name in the directory (`vx.config.ts`). */
  file: string
  /** Its resolved (post-evaluation) config, JSON-normalized. */
  config: ProjectConfig
}

export interface Lockfile {
  version: number
  /**
   * Root-relative POSIX directory (`.` for the root) → its project. Keyed
   * by directory, so a name a plugin gives never invalidates the lock.
   */
  projects: Record<string, LockedProject>
  /** Written by `writeLockfile` from the bytes; never read off the object. */
  validated?: string
}

export function lockfilePath(root: string): string {
  return path.join(root, LOCKFILE_NAME)
}

/** What a run says when a crash came from a hand-broken lock entry (2026-10-14). */
export const LOCK_INVALID = `${LOCKFILE_NAME} is invalid, run \`vx lock\``

/**
 * Whether the lock holds an entry `vx lock` could not have written. Runs
 * validate no entry, so a hand-broken one crashed deep in a run with a
 * raw TypeError; asked only on that crash's path, so a run pays nothing.
 */
export function lockEntryBroken(root: string): boolean {
  let projects: unknown
  try {
    projects = (JSON.parse(readFileSync(lockfilePath(root), 'utf8')) as { projects?: unknown })
      .projects
  } catch {
    return false
  }
  if (typeof projects !== 'object' || projects === null) return false
  for (const [dir, entry] of Object.entries(projects)) {
    try {
      validateProjectConfig((entry as LockedProject).config, `${LOCKFILE_NAME}: "${dir}"`, null)
    } catch {
      return true
    }
  }
  return false
}

/** What a run says when there is no lock to read. */
export const NO_LOCK = 'no lock: run `vx lock`'

/** Each read lock's bytes as a digest: every config a run loads from it is a function of them. */
const digests = new WeakMap<Lockfile, string>()

/** The digest of the bytes `lock` was read from; undefined for a lock no read made. */
export function lockDigest(lock: Lockfile): string | undefined {
  return digests.get(lock)
}

/**
 * Read and shape-validate `.vx/projects.lock.json`. Returns `null` when no lock
 * exists (the common case — the feature is opt-in). The lock is a
 * user-editable file, so this is a system boundary: malformed content
 * throws a `UserError` instead of crashing deeper in the run.
 */
export async function readLockfile(root: string): Promise<Lockfile | null> {
  const file = Bun.file(lockfilePath(root))
  if (!(await file.exists())) return null
  let parsed: unknown
  let text: string
  try {
    text = await file.text()
    parsed = JSON.parse(text)
  } catch {
    throw new UserError(`${LOCKFILE_NAME} is not valid JSON — re-run \`vx lock\` or delete it`)
  }
  // `Array.isArray` is not redundant with the `typeof` check: `typeof [] ===
  // 'object'` and `[] !== null`, so an array sails through and the NEXT check
  // reports `unsupported version undefined` — a version diagnostic for what is
  // actually a shape problem, sending the reader to re-run `vx lock` for a file
  // that was never the right shape. `validateProjectConfig` one layer down
  // already guards this explicitly, which is what makes the omission here an
  // inconsistency rather than an oversight.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UserError(`${LOCKFILE_NAME} must be a JSON object — re-run \`vx lock\``)
  }
  const lock = parsed as { version?: unknown; projects?: unknown }
  if (lock.version !== LOCKFILE_VERSION) {
    throw new UserError(
      `${LOCKFILE_NAME} has unsupported version ${String(lock.version)} ` +
        `(this vx expects ${LOCKFILE_VERSION}) — re-run \`vx lock\``,
    )
  }
  // Same trap, and this one is worse than a bad message: an ARRAY of entries is
  // ACCEPTED, because `Object.entries` happily walks it — yielding a project
  // at directory "0".
  if (typeof lock.projects !== 'object' || lock.projects === null || Array.isArray(lock.projects)) {
    throw new UserError(`${LOCKFILE_NAME}: \`projects\` must be an object — re-run \`vx lock\``)
  }
  for (const [dir, entry] of Object.entries(lock.projects)) {
    // A run joins the key onto the root: `../x` ran a project outside it.
    if (!isLockKey(dir))
      throw new UserError(
        `${LOCKFILE_NAME}: "${dir}" is not a directory under the workspace root — re-run \`vx lock\``,
      )
    const { file, config } = (entry ?? {}) as { file?: unknown; config?: unknown }
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      typeof file !== 'string' ||
      !PROJECT_CONFIG_FILENAMES.includes(file) ||
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new UserError(`${LOCKFILE_NAME}: entry for "${dir}" is malformed — re-run \`vx lock\``)
    }
  }
  digests.set(parsed as Lockfile, xxh3hex(text))
  return parsed as Lockfile
}

/**
 * `vx lock` evaluates and validates every config, then writes a digest of
 * the bytes it wrote, under vx's version, as the last field: the lock's
 * record of which vx validated it. No reader consults it.
 */
function validatedDigest(body: string): string {
  return xxh3(`vx-lock-valid-v3\0${VERSION}\0${body}`).toString(16)
}

/**
 * Each task's config with its keys sorted (`keysSorted`), so a run's key
 * check finds it sorted and copies nothing. The tasks keep their order,
 * which `vx show` lists them in.
 */
function taskKeysSorted(key: string, value: unknown): unknown {
  if (key !== 'tasks' || value === null || typeof value !== 'object' || Array.isArray(value))
    return value
  // Entries, not assignment: a task named `__proto__` set the prototype.
  return Object.fromEntries(Object.entries(value).map(([name, task]) => [name, keysSorted(task)]))
}

export async function writeLockfile(root: string, lock: Lockfile): Promise<void> {
  // Written beside its name and renamed over it: `Bun.write` truncates in
  // place, so a run, or `vx watch` woken by the write
  // itself (item 971), could read an empty or half-written lock and fail
  // on "not valid JSON" (item 972).
  const file = lockfilePath(root)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    // Minified: the file only vx reads, and it loads faster than pretty
    // JSON (measured, 10k projects: 15.6 ms against 22.5 ms). `vx.lock.json`
    // beside each config is the copy for people.
    const body = JSON.stringify({ version: lock.version, projects: lock.projects }, taskKeysSorted)
    await Bun.write(tmp, `${body.slice(0, -1)},"validated":"${validatedDigest(body)}"}\n`)
    await rename(tmp, file)
  } catch (err) {
    // Best effort: where the write was refused the temp cannot be named
    // either (ENOTDIR), and that must not replace the refusal itself.
    await rm(tmp, { force: true }).catch(() => {})
    // The refusal names the file the user knows: a read-only checkout read
    // `open '…/.vx/projects.lock.json.tmp-…'` where it had read the lock's own name.
    const e = err as NodeJS.ErrnoException
    if (typeof e.message === 'string') e.message = e.message.split(tmp).join(file)
    if (e.path === tmp) e.path = file
    throw err
  }
}

/**
 * Run-time config load from the lock: return the FROZEN resolved config
 * for each project, in order. No evaluation happens, and no staleness
 * check or schema validation either: the lock's contract is "what runs is
 * what was locked", `vx lock` validated every entry it wrote, and
 * `vx lock --check` re-evaluates them all. An unlocked project is a hard
 * error; a run never evaluates.
 */
export function frozenProjectConfigs(
  lock: Lockfile,
  metas: ReadonlyArray<{ name: string; dir: string; configPath: string }>,
  root: string,
): ProjectConfig[] {
  return metas.map((meta) => {
    const dir = lockKey(root, meta.dir)
    // Own entries only: `constructor` read Object's, "locked" at undefined (D-152).
    const entry = Object.hasOwn(lock.projects, dir) ? lock.projects[dir] : undefined
    if (entry === undefined) {
      throw new UserError(
        `${LOCKFILE_NAME} has no entry for "${meta.name}" (${relPosix(root, meta.configPath)}) — ` +
          'run `vx lock`',
      )
    }
    return entry.config
  })
}

/** An empty, `.` or `..` segment. A regex: a split per key was 1.2 ms of a 10k-project read, this 0.4 ms. */
const BAD_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/

/** Whether `dir` is a key `lockKey` could give: `.`, or a relative POSIX path with no empty, `.` or `..` segment. */
function isLockKey(dir: string): boolean {
  return dir === '.' || (!dir.startsWith('/') && !BAD_SEGMENT.test(dir))
}

/** A project directory as the lock keys it: root-relative POSIX, `.` for the root. */
export function lockKey(root: string, dir: string): string {
  return relPosix(root, dir) || '.'
}
