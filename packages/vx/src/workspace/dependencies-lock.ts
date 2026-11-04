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
const DEPENDENCIES_LOCK_VERSION = 1

export interface DependenciesLock {
  version: number
  /** Project directory (root-relative POSIX, `.` for the root) → the directories it links to. */
  projects: Record<string, { deps?: string[]; reach?: string[] }>
  /** Claimed file → the hash of the bytes digested and each project directory's digest. */
  files: Record<string, { hash: string; projects: Record<string, string> }>
}

/** The lock for `metas`, with `files` keyed by project name as the claims answer. */
export function dependenciesLock(
  root: string,
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<string, { hash: string; projects: Readonly<Record<string, string>> }>,
): DependenciesLock {
  const dirOf = new Map(metas.map((m) => [m.name, lockKey(root, m.dir)]))
  const dirs = (names: readonly string[] | undefined): string[] | undefined => {
    const out = [...new Set((names ?? []).flatMap((n) => dirOf.get(n) ?? []))].sort()
    return out.length === 0 ? undefined : out
  }
  const projects: DependenciesLock['projects'] = {}
  for (const m of [...metas].sort((a, b) => cmp(dirOf.get(a.name)!, dirOf.get(b.name)!))) {
    const deps = dirs(m.deps)
    const reach = dirs(m.reach)
    projects[dirOf.get(m.name)!] = {
      ...(deps !== undefined ? { deps } : {}),
      ...(reach !== undefined ? { reach } : {}),
    }
  }
  const out: DependenciesLock['files'] = {}
  for (const file of [...files.keys()].sort(cmp)) {
    const { hash, projects: byName } = files.get(file)!
    const digests: Record<string, string> = {}
    for (const name of Object.keys(byName).sort((a, b) => cmp(dirOf.get(a)!, dirOf.get(b)!)))
      digests[dirOf.get(name)!] = byName[name]!
    out[file] = { hash, projects: digests }
  }
  return { version: DEPENDENCIES_LOCK_VERSION, projects, files: out }
}

/** The committed text: pretty, so a dependency change reads as a diff. */
function dependenciesLockText(lock: DependenciesLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`
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
    if (
      lock.version !== DEPENDENCIES_LOCK_VERSION ||
      typeof lock.projects !== 'object' ||
      lock.projects === null ||
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
  return Object.entries(lock.projects)
    .filter(([, e]) => e.deps?.includes(dir) || e.reach?.includes(dir))
    .map(([d]) => d)
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
