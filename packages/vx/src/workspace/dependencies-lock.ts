// .vx/dependencies.lock.json — what the workspace's dependencies resolve
// to, written by `vx lock` beside the config lock and committed.
//
// Each project's edges (the `discover` stage's `deps` and `reach`), by
// directory, and each claimed file's per-project digests
// (`FingerprintClaim.digests`) with the hash of the bytes they came from.
// `--affected` reads the base commit's copy with git: a deleted project's
// dependants are in its edges, and a changed lockfile's base digests are
// there, so the base side is never parsed. `vx lock --check` holds it to a
// fresh derivation.

import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectMeta } from './workspace.js'
import { lockKey } from './lockfile.js'

export const DEPENDENCIES_LOCK_NAME = '.vx/dependencies.lock.json'
const DEPENDENCIES_LOCK_VERSION = 2

// Flat: each directory once, everything else an index into `projects`, so
// a parse builds few strings and a lookup is an array read.
export interface DependenciesLock {
  version: number
  /** Project directories (root-relative POSIX, `.` for the root), sorted. */
  projects: string[]
  /** Per project, the indexes of the projects it builds after. */
  deps: number[][]
  /** Per project, the indexes of the projects it reaches for selection only. */
  reach: number[][]
  /** Claimed file → the hash of the bytes digested and each project's digest, by index ('' when none). */
  files: Record<string, { hash: string; digests: string[] }>
}

/** The lock for `metas`, with `files` keyed by project name as the claims answer. */
export function dependenciesLock(
  root: string,
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<string, { hash: string; projects: Readonly<Record<string, string>> }>,
): DependenciesLock {
  const dirOf = new Map(metas.map((m) => [m.name, lockKey(root, m.dir)]))
  const projects = [...new Set(dirOf.values())].sort(cmp)
  const at = new Map(projects.map((d, i) => [d, i]))
  const byDir = new Map(metas.map((m) => [dirOf.get(m.name)!, m]))
  const indexes = (names: readonly string[] | undefined): number[] =>
    [...new Set((names ?? []).flatMap((n) => at.get(dirOf.get(n) ?? '') ?? []))].sort(
      (a, b) => a - b,
    )
  const out: DependenciesLock['files'] = {}
  for (const file of [...files.keys()].sort(cmp)) {
    const { hash, projects: byName } = files.get(file)!
    const digests = projects.map(() => '')
    for (const [name, digest] of Object.entries(byName)) {
      const i = at.get(dirOf.get(name) ?? '')
      if (i !== undefined) digests[i] = digest
    }
    out[file] = { hash, digests }
  }
  return {
    version: DEPENDENCIES_LOCK_VERSION,
    projects,
    deps: projects.map((d) => indexes(byDir.get(d)!.deps)),
    reach: projects.map((d) => indexes(byDir.get(d)!.reach)),
    files: out,
  }
}

/** Minified, as the config lock: only vx reads it, and minified JSON parses faster. */
function dependenciesLockText(lock: DependenciesLock): string {
  return `${JSON.stringify(lock)}\n`
}

/** Written beside its name and renamed over it, as `writeLockfile`: a reader never sees half a file. */
export async function writeDependenciesLock(root: string, lock: DependenciesLock): Promise<void> {
  const file = path.join(root, DEPENDENCIES_LOCK_NAME)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await Bun.write(tmp, dependenciesLockText(lock))
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    const e = err as NodeJS.ErrnoException
    if (typeof e.message === 'string') e.message = e.message.split(tmp).join(file)
    if (e.path === tmp) e.path = file
    throw err
  }
}

/** The lock in `bytes`; null when absent, another version, or not this shape. */
export function parseDependenciesLock(bytes: Uint8Array | null): DependenciesLock | null {
  if (bytes === null) return null
  try {
    const lock = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DependenciesLock>
    const n = lock.projects?.length
    if (
      lock.version !== DEPENDENCIES_LOCK_VERSION ||
      !Array.isArray(lock.projects) ||
      !Array.isArray(lock.deps) ||
      lock.deps.length !== n ||
      !Array.isArray(lock.reach) ||
      lock.reach.length !== n ||
      typeof lock.files !== 'object' ||
      lock.files === null
    )
      return null
    return lock as DependenciesLock
  } catch {
    return null
  }
}

/** The project directories whose edges reach `dir`. */
export function dependantsOf(lock: DependenciesLock, dir: string): string[] {
  const i = lock.projects.indexOf(dir)
  if (i < 0) return []
  return lock.projects.filter((_, j) => lock.deps[j]!.includes(i) || lock.reach[j]!.includes(i))
}

/** `file`'s recorded hash and each project directory's digest (undefined when none). */
export function recordedDigests(
  lock: DependenciesLock,
  file: string,
): { hash: string; of: (dir: string) => string | undefined } | undefined {
  const rec = Object.hasOwn(lock.files, file) ? lock.files[file] : undefined
  if (rec === undefined) return undefined
  const at = new Map(lock.projects.map((d, i) => [d, i]))
  return {
    hash: rec.hash,
    of: (dir) => {
      const i = at.get(dir)
      return i === undefined || rec.digests[i] === '' ? undefined : rec.digests[i]
    },
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
