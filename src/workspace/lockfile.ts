// vx-lock.json — frozen resolved-config lockfile.
//
// `vx lock` evaluates every project's vx.config.* in the CURRENT
// environment and freezes the resolved objects (plus a content hash of
// each config file) into `vx-lock.json` at the workspace root. While the
// lock exists, runs load configs from it instead of evaluating —
// frozen-env semantics. See docs/design/config-lock-2026-06.md.
//
// Verification asymmetry (deliberate):
//   - runs TRUST the lock: hash-only staleness check, eval-free.
//   - `vx lock --check` AUDITS it: full re-evaluation + deep equality,
//     which catches eval-time env drift that file hashes cannot see.

import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import { relPosix, UserError, xxh3hex } from '../util/index.js'
import { validateProjectConfig } from './project-loader.js'

export const LOCKFILE_NAME = 'vx-lock.json'
export const LOCKFILE_VERSION = 1

export interface LockfileEntry {
  /** Workspace-root-relative POSIX path to the project's config file. */
  configPath: string
  /** xxh3 hex of the config file bytes at lock time. */
  configHash: string
  /** The resolved (post-evaluation) config object, JSON-normalized. */
  config: ProjectConfig
}

export interface Lockfile {
  version: number
  projects: Record<string, LockfileEntry>
}

export function lockfilePath(root: string): string {
  return path.join(root, LOCKFILE_NAME)
}

/**
 * Read and shape-validate `vx-lock.json`. Returns `null` when no lock
 * exists (the common case — the feature is opt-in). The lock is a
 * user-editable file, so this is a system boundary: malformed content
 * throws a `UserError` instead of crashing deeper in the run.
 */
export async function readLockfile(root: string): Promise<Lockfile | null> {
  const file = Bun.file(lockfilePath(root))
  if (!(await file.exists())) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new UserError(`${LOCKFILE_NAME} is not valid JSON — re-run \`vx lock\` or delete it`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new UserError(`${LOCKFILE_NAME} must be a JSON object — re-run \`vx lock\``)
  }
  const lock = parsed as { version?: unknown; projects?: unknown }
  if (lock.version !== LOCKFILE_VERSION) {
    throw new UserError(
      `${LOCKFILE_NAME} has unsupported version ${String(lock.version)} ` +
        `(this vx expects ${LOCKFILE_VERSION}) — re-run \`vx lock\``,
    )
  }
  if (typeof lock.projects !== 'object' || lock.projects === null) {
    throw new UserError(`${LOCKFILE_NAME}: \`projects\` must be an object — re-run \`vx lock\``)
  }
  for (const [name, entry] of Object.entries(lock.projects)) {
    const e = entry as Partial<LockfileEntry> | null
    if (
      !e ||
      typeof e.configPath !== 'string' ||
      typeof e.configHash !== 'string' ||
      typeof e.config !== 'object' ||
      e.config === null
    ) {
      throw new UserError(`${LOCKFILE_NAME}: entry for "${name}" is malformed — re-run \`vx lock\``)
    }
  }
  return parsed as Lockfile
}

export async function writeLockfile(root: string, lock: Lockfile): Promise<void> {
  await Bun.write(lockfilePath(root), `${JSON.stringify(lock, null, 2)}\n`)
}

/**
 * Run-time config load from the lock: verify the config file's content
 * hash against the lock entry, then return the FROZEN resolved config.
 * No evaluation happens — this is the fast, eval-free trust path. A
 * changed file or an unlocked project is a hard error: the lock's
 * contract is "what runs is what was locked", and silently falling
 * back to evaluation would break frozen-env semantics.
 */
export async function frozenProjectConfig(
  lock: Lockfile,
  meta: { name: string; configPath: string },
  root: string,
): Promise<ProjectConfig> {
  const rel = relPosix(root, meta.configPath)
  const entry = lock.projects[meta.name]
  if (!entry || entry.configPath !== rel) {
    throw new UserError(
      `${LOCKFILE_NAME} has no entry for "${meta.name}" (${rel}) — ` +
        `run \`vx lock\` to refresh, or delete ${LOCKFILE_NAME}`,
    )
  }
  const hash = xxh3hex(await Bun.file(meta.configPath).bytes())
  if (hash !== entry.configHash) {
    throw new UserError(
      `${LOCKFILE_NAME} is stale: ${rel} changed since \`vx lock\` (${meta.name}) — ` +
        `run \`vx lock\` to refresh, or delete ${LOCKFILE_NAME}`,
    )
  }
  // The lock is hand-editable; the stored config crosses the same
  // boundary a freshly evaluated one does.
  validateProjectConfig(entry.config, `${LOCKFILE_NAME} (${meta.name})`)
  return entry.config
}
