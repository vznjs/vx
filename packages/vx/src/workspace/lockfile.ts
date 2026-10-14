// .vx/lock.json — frozen resolved-config lockfile.
//
// `vx lock` evaluates every project's vx.config.* in the CURRENT
// environment and freezes the resolved objects, by project name, into
// `.vx/lock.json` at the workspace root. A run
// under `--frozen` loads configs from it instead of evaluating —
// frozen-env semantics; a plain run always evaluates live. See
// docs/design/config-lock-2026-06.md.
//
// Verification asymmetry (deliberate):
//   - `--frozen` runs TRUST the lock: no staleness check, no schema
//     validation, eval-free.
//   - `vx lock --check` AUDITS it: full re-evaluation + deep equality.

import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import { relPosix, UserError, xxh3 } from '../util/index.js'
import { VERSION } from '../version.js'
import { CONFIG_EVAL_VERSION } from './config-cache.js'

export const LOCKFILE_NAME = '.vx/lock.json'
export const LOCKFILE_VERSION = 2

export interface Lockfile {
  version: number
  /** Project name → its resolved (post-evaluation) config, JSON-normalized. */
  projects: Record<string, ProjectConfig>
  /** Written by `writeLockfile` from the bytes; never read off the object. */
  validated?: string
}

export function lockfilePath(root: string): string {
  return path.join(root, LOCKFILE_NAME)
}

/** What a `--frozen` verb says when there is no lock to read. */
export const FROZEN_WITHOUT_LOCK =
  "--frozen requires .vx/lock.json at the workspace root — run 'vx lock' and commit it"

/**
 * Read and shape-validate `.vx/lock.json`. Returns `null` when no lock
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
  // literally named "0". `--frozen` then looks up real project names against a
  // lock that declares none of them.
  if (typeof lock.projects !== 'object' || lock.projects === null || Array.isArray(lock.projects)) {
    throw new UserError(`${LOCKFILE_NAME}: \`projects\` must be an object — re-run \`vx lock\``)
  }
  for (const [name, entry] of Object.entries(lock.projects)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new UserError(`${LOCKFILE_NAME}: entry for "${name}" is malformed — re-run \`vx lock\``)
    }
  }
  return parsed as Lockfile
}

/**
 * `vx lock` evaluates and validates every config, then writes a digest of
 * the bytes it wrote, under vx's version, as the last field: the lock's
 * record of which vx validated it. No reader consults it.
 */
function validatedDigest(body: string): string {
  return xxh3(`vx-lock-valid-v${CONFIG_EVAL_VERSION}\0${VERSION}\0${body}`).toString(16)
}

export async function writeLockfile(root: string, lock: Lockfile): Promise<void> {
  // Written beside its name and renamed over it: `Bun.write` truncates in
  // place, so a `--frozen` run, or `vx watch --frozen` woken by the write
  // itself (item 971), could read an empty or half-written lock and fail
  // on "not valid JSON" (item 972).
  const file = lockfilePath(root)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    // Minified: the file only vx reads, and it loads faster than pretty
    // JSON (measured, 10k projects: 15.6 ms against 22.5 ms). `vx.lock.json`
    // beside each config is the copy for people.
    const body = JSON.stringify({ version: lock.version, projects: lock.projects })
    await Bun.write(tmp, `${body.slice(0, -1)},"validated":"${validatedDigest(body)}"}\n`)
    await rename(tmp, file)
  } catch (err) {
    // Best effort: where the write was refused the temp cannot be named
    // either (ENOTDIR), and that must not replace the refusal itself.
    await rm(tmp, { force: true }).catch(() => {})
    // The refusal names the file the user knows: a read-only checkout read
    // `open '…/.vx/lock.json.tmp-…'` where it had read the lock's own name.
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
 * error; silently falling back to evaluation would break frozen-env
 * semantics.
 */
export function frozenProjectConfigs(
  lock: Lockfile,
  metas: ReadonlyArray<{ name: string; configPath: string }>,
  root: string,
): ProjectConfig[] {
  return metas.map((meta) => {
    // Own entries only: `constructor` read Object's, "locked" at undefined (D-152).
    const config = Object.hasOwn(lock.projects, meta.name) ? lock.projects[meta.name] : undefined
    if (config === undefined) {
      throw new UserError(
        `${LOCKFILE_NAME} has no entry for "${meta.name}" (${relPosix(root, meta.configPath)}) — ` +
          `run \`vx lock\` to refresh, or delete ${LOCKFILE_NAME}`,
      )
    }
    return config
  })
}
