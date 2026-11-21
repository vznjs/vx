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
const DEPENDENCIES_LOCK_VERSION = 4

// Laid out for the parse first, then the size, as every run parses it:
// one `graph` array, each directory once and every edge an index, each
// project's digests inside its own directory string (read by indexOf and
// slice, never split, and only for the project asked about), and nothing
// written for a slot that is empty.
export interface DependenciesLock {
  version: number
  /**
   * Per project, sorted by directory: a string, `dir[,digest…]`, its
   * digest for each claimed file in `files` order with trailing empty
   * slots left out (a directory holding a comma keeps every slot, so its
   * row holds more commas than there are files); then the indexes of the
   * projects it builds after, sorted; then `-(index + 1)` of each it
   * reaches for selection only, sorted. An index counts the strings.
   */
  graph: (string | number)[]
  /** Each claimed file, sorted, then the xxh3 of its bytes: `[file, hash, file, hash, …]`. */
  files: string[]
  /** Claimed file → each root-relative file besides it whose bytes its digests read → that file's hash (`hashExtra`); absent when none. */
  extras?: Record<string, Record<string, string>>
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
  const names = [...files.keys()].sort(cmp)
  const digests = names.map(() => dirs.map(() => ''))
  const flat: string[] = []
  const extras: Record<string, Record<string, string>> = {}
  names.forEach((file, f) => {
    const { hash, projects: byName, extras: read } = files.get(file)!
    flat.push(file, hash)
    for (const [name, digest] of Object.entries(byName)) {
      const i = at.get(dirOf.get(name) ?? '')
      if (i === undefined) continue
      if (digest.includes(','))
        throw new UserError(
          `${file}: the digest for ${dirs[i]} holds a comma, which ${DEPENDENCIES_LOCK_NAME} cannot record — the fingerprint plugin claiming it must answer without one`,
          'VX_E_LOCK',
        )
      digests[f]![i] = digest
    }
    const rels = Object.keys(read ?? {}).sort(cmp)
    if (rels.length > 0) extras[file] = Object.fromEntries(rels.map((r) => [r, read![r]!]))
  })
  const indexes = (list: readonly string[] | undefined): number[] => {
    if (list === undefined || list.length === 0) return []
    const to = new Set<number>()
    for (const n of list) {
      const j = at.get(dirOf.get(n) ?? '')
      if (j !== undefined) to.add(j)
    }
    return [...to].sort((a, b) => a - b)
  }
  const graph: (string | number)[] = []
  dirs.forEach((dir, i) => {
    graph.push(
      rowOf(
        dir,
        digests.map((d) => d[i]!),
      ),
    )
    const meta = byDir.get(dir)!
    for (const j of indexes(meta.deps)) graph.push(j)
    for (const j of indexes(meta.reach)) graph.push(-1 - j)
  })
  return {
    version: DEPENDENCIES_LOCK_VERSION,
    graph,
    files: flat,
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  }
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
  if (lock.version !== DEPENDENCIES_LOCK_VERSION) return null
  const read = shapeOf(lock)
  if (read === null) return null
  views.set(lock as DependenciesLock, read)
  return lock as DependenciesLock
}

/** Each project's directory and row, in index order, and each claimed file's index. */
interface View {
  dirs: string[]
  rows: string[]
  slots: number
  at?: Map<string, number>
}

const views = new WeakMap<DependenciesLock, View>()

function viewOf(lock: DependenciesLock): View {
  let view = views.get(lock)
  if (view === undefined) {
    view = shapeOf(lock)!
    views.set(lock, view)
  }
  return view
}

// A committed file a merge or a hand edit can break inside, so every
// entry is checked: one bad entry read on would throw a raw TypeError at
// its first lookup instead of the "invalid, run `vx lock`" refusal. The
// pass that checks the rows is the one that reads their directories.
function shapeOf(lock: Partial<DependenciesLock>): View | null {
  const { graph, files, extras } = lock
  if (!Array.isArray(graph) || !Array.isArray(files) || files.length % 2 !== 0) return null
  for (const f of files) if (typeof f !== 'string') return null
  if (extras !== undefined) {
    if (!isRecord(extras)) return null
    for (const rec of Object.values(extras)) {
      if (!isRecord(rec)) return null
      for (const h of Object.values(rec)) if (typeof h !== 'string') return null
    }
  }
  const slots = files.length / 2
  const dirs: string[] = []
  const rows: string[] = []
  for (const v of graph) {
    if (typeof v !== 'string') {
      if (rows.length === 0) return null
      continue
    }
    const dir = dirIn(v, slots)
    if (dir === '') return null
    dirs.push(dir)
    rows.push(v)
  }
  const n = dirs.length
  for (const v of graph)
    if (typeof v !== 'string' && !(Number.isInteger(v) && v >= -n && v < n)) return null
  return { dirs, rows, slots }
}

// The directory a row starts with: up to its first comma, unless the row
// holds more commas than there are slots (a directory with a comma in it,
// written with every slot), then up to the last `slots` of them.
function dirIn(row: string, slots: number): string {
  const first = row.indexOf(',')
  if (first < 0) return row
  let commas = 1
  for (let c = row.indexOf(',', first + 1); c >= 0; c = row.indexOf(',', c + 1)) commas++
  if (commas <= slots) return row.slice(0, first)
  let end = row.length
  for (let k = 0; k < slots; k++) end = row.lastIndexOf(',', end - 1)
  return row.slice(0, end)
}

// Slot `f` of a row whose directory is `dir`; '' when it was left out or empty.
function slotIn(row: string, dir: string, f: number): string {
  let start = dir.length + 1
  if (start > row.length) return ''
  for (let k = 0; k < f; k++) {
    const c = row.indexOf(',', start)
    if (c < 0) return ''
    start = c + 1
  }
  const end = row.indexOf(',', start)
  return row.slice(start, end < 0 ? row.length : end)
}

// A directory and its digest slots, trailing empty ones left out unless
// the directory holds a comma (`dirIn` then counts every slot).
function rowOf(dir: string, slots: readonly string[]): string {
  let last = dir.includes(',') ? slots.length - 1 : -1
  for (let f = slots.length - 1; f > last; f--) if (slots[f] !== '') last = f
  let row = dir
  for (let f = 0; f <= last; f++) row += `,${slots[f]}`
  return row
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The project directories whose edges reach `dir`. */
export function dependantsOf(lock: DependenciesLock, dir: string): string[] {
  const { dirs } = viewOf(lock)
  const i = dirs.indexOf(dir)
  if (i < 0) return []
  const out: string[] = []
  let row = -1
  for (const v of lock.graph) {
    if (typeof v === 'string') row++
    else if ((v < 0 ? -1 - v : v) === i && out[out.length - 1] !== dirs[row]) out.push(dirs[row]!)
  }
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
  let f = -1
  for (let k = 0; k < lock.files.length; k += 2) if (lock.files[k] === file) f = k / 2
  if (f < 0) return undefined
  const view = viewOf(lock)
  view.at ??= new Map(view.dirs.map((d, i) => [d, i]))
  const at = view.at
  return {
    hash: lock.files[f * 2 + 1]!,
    extras: (Object.hasOwn(lock.extras ?? {}, file) ? lock.extras![file] : undefined) ?? {},
    has: (dir) => at.has(dir),
    of: (dir) => {
      const i = at.get(dir)
      if (i === undefined) return undefined
      const digest = slotIn(view.rows[i]!, dir, f)
      return digest === '' ? undefined : digest
    },
  }
}

/**
 * `read` with each file's record taken from `fresh` where only the files
 * its digests read moved (same bytes, same extra files, an extra's hash
 * changed): a run digests anew on such an edit (`lockfileClaim`'s
 * `lockedOnce`), and cli.md says it needs no `vx lock`, yet `--check`
 * failed every edit in a `file:` directory or a patch. With every hash
 * unchanged a run keys from the record, so its digests are compared.
 */
export function liveRecords(read: DependenciesLock, fresh: DependenciesLock): DependenciesLock {
  const extras = { ...read.extras }
  const live = new Map<number, number>()
  for (let k = 0; k < fresh.files.length; k += 2) {
    const name = fresh.files[k]!
    const r = read.files.indexOf(name)
    if (r < 0 || r % 2 !== 0 || read.files[r + 1] !== fresh.files[k + 1]) continue
    const was = read.extras?.[name] ?? {}
    const now = fresh.extras?.[name] ?? {}
    if (!Bun.deepEquals(Object.keys(was), Object.keys(now)) || Bun.deepEquals(was, now)) continue
    extras[name] = now
    live.set(r / 2, k / 2)
  }
  if (live.size === 0) return read
  const theirs = viewOf(fresh)
  const ours = viewOf(read)
  // Another project list fails the comparison whatever the digests say.
  if (!Bun.deepEquals(ours.dirs, theirs.dirs)) return { ...read, extras }
  let row = -1
  const graph = read.graph.map((v) => {
    if (typeof v !== 'string') return v
    row++
    const dir = ours.dirs[row]!
    const slots: string[] = []
    for (let f = 0; f < ours.slots; f++) {
      const from = live.get(f)
      slots.push(from === undefined ? slotIn(v, dir, f) : slotIn(theirs.rows[row]!, dir, from))
    }
    return rowOf(dir, slots)
  })
  return { ...read, graph, extras }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
