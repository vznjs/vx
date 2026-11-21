// .vx/dependencies.lock.json — what the workspace's dependencies resolve
// to, written by `vx lock` beside the config lock and committed.
//
// Each project's edges (the `discover` stage's `deps` and `reach`), by
// directory, and each claimed file's per-project digests
// (`FingerprintClaim.digests`) with the hash of the bytes they came from
// and of each other file the digests read. A run keys from these digests
// and never parses the file: one whose bytes moved since refuses
// (orchestrator/locked-digests.ts). `--affected` reads the base commit's
// copy with git: a deleted project's dependants are in its edges, and a
// changed lockfile's base digests are there, so the base side is never
// parsed. `vx lock --check` holds it to a fresh derivation.

import path from 'node:path'
import { type PendingWrite, UserError } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'
import { lockKey } from './lockfile.js'
import { type LoadReads, readOnce } from './load-reads.js'

export const DEPENDENCIES_LOCK_NAME = '.vx/dependencies.lock.json'
const DEPENDENCIES_LOCK_VERSION = 5

// Flat: each directory once, everything else an index into `projects`, so
// a parse builds few strings and a lookup is an array read. A project's
// edges ride on its own row, and an empty list at a row's end is left
// out: most projects have no reach and many no deps.
export interface DependenciesLock {
  version: number
  /** Per project, sorted by directory: its directory (root-relative POSIX, `.` for the root), then `ProjectRow`'s edges. */
  projects: ProjectRow[]
  /** Claimed file → its bytes' xxh3, each project's digest by index ('' when none), and each other file read → its hash. */
  files: Record<string, LockedFile>
}

/**
 * `[dir, deps?, reach?]`: the indexes of the projects it builds after, then
 * of those it reaches for selection only, each sorted; a trailing empty list
 * is left out, so deps stays `[]` only before a reach.
 */
type ProjectRow = [dir: string, deps?: number[], reach?: number[]]

interface LockedFile {
  hash: string
  digests: string[]
  /** Root-relative files besides this one whose bytes the digests read → their hash (`hashExtra`). */
  extras?: Record<string, string>
}

/** The lock for `metas`, with `files` keyed by project name as the claims answer. */
export function dependenciesLock(
  root: string,
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<
    string,
    {
      hash: string
      projects: Readonly<Record<string, string>>
      extras?: Readonly<Record<string, string>>
    }
  >,
): DependenciesLock {
  const dirOf = new Map(metas.map((m) => [m.name, lockKey(root, m.dir)]))
  const dirs = [...new Set(dirOf.values())].sort(cmp)
  const at = new Map(dirs.map((d, i) => [d, i]))
  const byDir = new Map(metas.map((m) => [dirOf.get(m.name)!, m]))
  const indexes = (names: readonly string[] | undefined): number[] => {
    if (names === undefined || names.length === 0) return []
    const to = new Set<number>()
    for (const n of names) {
      const j = at.get(dirOf.get(n) ?? '')
      if (j !== undefined) to.add(j)
    }
    return [...to].sort((a, b) => a - b)
  }
  const projects = dirs.map((dir): ProjectRow => {
    const meta = byDir.get(dir)!
    const deps = indexes(meta.deps)
    const reach = indexes(meta.reach)
    return reach.length > 0 ? [dir, deps, reach] : deps.length > 0 ? [dir, deps] : [dir]
  })
  const out: DependenciesLock['files'] = {}
  for (const file of [...files.keys()].sort(cmp)) {
    const { hash, projects: byName, extras } = files.get(file)!
    const digests = dirs.map(() => '')
    for (const [name, digest] of Object.entries(byName)) {
      const i = at.get(dirOf.get(name) ?? '')
      if (i !== undefined) digests[i] = digest
    }
    const rels = Object.keys(extras ?? {}).sort(cmp)
    out[file] =
      rels.length === 0
        ? { hash, digests }
        : { hash, digests, extras: Object.fromEntries(rels.map((r) => [r, extras![r]!])) }
  }
  return { version: DEPENDENCIES_LOCK_VERSION, projects, files: out }
}

/** Minified, as the config lock: only vx reads it, and minified JSON parses faster. */
function dependenciesLockText(lock: DependenciesLock): string {
  return `${JSON.stringify(lock)}\n`
}

/** The dependency lock's file and bytes, for `writeAllOrNone`. */
export function dependenciesLockWrite(root: string, lock: DependenciesLock): PendingWrite {
  return {
    file: path.join(root, DEPENDENCIES_LOCK_NAME),
    text: dependenciesLockText(lock),
    shown: DEPENDENCIES_LOCK_NAME,
  }
}

/** The lock's bytes at `root`, read once per `reads`; null when there is none. */
export function readDependenciesLock(root: string, reads?: LoadReads): Promise<Uint8Array | null> {
  return readOnce(reads, path.join(root, DEPENDENCIES_LOCK_NAME))
}

/**
 * The lock in `bytes`; null when absent, an older version, or not this
 * shape. A newer version throws: "run `vx lock`" there would have this vx
 * write its older version over the file.
 */
export function parseDependenciesLock(bytes: Uint8Array | null): DependenciesLock | null {
  if (bytes === null) return null
  let lock: Partial<DependenciesLock>
  try {
    lock = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DependenciesLock>
  } catch {
    return null
  }
  if (typeof lock?.version === 'number' && lock.version > DEPENDENCIES_LOCK_VERSION)
    throw new UserError(
      `${DEPENDENCIES_LOCK_NAME} was written by a newer vx (version ${lock.version}; this vx reads ${DEPENDENCIES_LOCK_VERSION}) — upgrade vx`,
      'VX_E_LOCK',
    )
  try {
    return lock.version === DEPENDENCIES_LOCK_VERSION && wellFormed(lock)
      ? (lock as DependenciesLock)
      : null
  } catch {
    return null
  }
}

// A committed file a merge or a hand edit can break inside, so every
// entry is checked: one bad entry read on would throw a raw TypeError at
// its first lookup instead of the "invalid, run `vx lock`" refusal.
function wellFormed(lock: Partial<DependenciesLock>): boolean {
  const { projects, files } = lock
  if (!Array.isArray(projects) || !isRecord(files)) return false
  const n = projects.length
  for (const row of projects as unknown[]) {
    if (!Array.isArray(row) || row.length < 1 || row.length > 3 || typeof row[0] !== 'string')
      return false
    if (row.length > 1 && !indexesFit(row[1], n)) return false
    if (row.length > 2 && !indexesFit(row[2], n)) return false
  }
  return Object.values(files).every(
    (rec: unknown) =>
      isRecord(rec) &&
      typeof rec['hash'] === 'string' &&
      Array.isArray(rec['digests']) &&
      rec['digests'].length === n &&
      rec['digests'].every((d) => typeof d === 'string') &&
      (rec['extras'] === undefined ||
        (isRecord(rec['extras']) &&
          Object.values(rec['extras']).every((h) => typeof h === 'string'))),
  )
}

function indexesFit(v: unknown, n: number): boolean {
  if (!Array.isArray(v)) return false
  for (const i of v) if (!Number.isInteger(i) || i < 0 || i >= n) return false
  return true
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The project directories whose edges reach `dir`. */
export function dependantsOf(lock: DependenciesLock, dir: string): string[] {
  const i = lock.projects.findIndex((row) => row[0] === dir)
  if (i < 0) return []
  const out: string[] = []
  for (const [d, deps, reach] of lock.projects)
    if (deps?.includes(i) === true || reach?.includes(i) === true) out.push(d)
  return out
}

/** `file`'s recorded hashes and each project directory's digest (undefined when none). */
export function recordedDigests(
  lock: DependenciesLock,
  file: string,
):
  | {
      hash: string
      extras: Readonly<Record<string, string>>
      has: (dir: string) => boolean
      of: (dir: string) => string | undefined
    }
  | undefined {
  const rec = Object.hasOwn(lock.files, file) ? lock.files[file] : undefined
  if (rec === undefined) return undefined
  const at = new Map(lock.projects.map((row, i) => [row[0], i]))
  return {
    hash: rec.hash,
    extras: rec.extras ?? {},
    has: (dir) => at.has(dir),
    of: (dir) => {
      const i = at.get(dir)
      return i === undefined || rec.digests[i] === '' ? undefined : rec.digests[i]
    },
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
