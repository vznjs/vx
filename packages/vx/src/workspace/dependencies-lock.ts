// .vx/dependencies.lock — the workspace's resolved graph and what its
// dependencies resolve to, written by `vx lock` beside the config lock and
// committed.
//
// Each project's edges (the `discover` stage's `deps` and `reach`, which
// live nowhere else), and each claimed file's per-project digests
// (`FingerprintClaim.digests`) with the hash of each other file the digests
// read. No hash of the claimed file itself: every change to it would rewrite
// that one line, and two pull requests that each touched it would conflict
// there on GitHub, which runs no merge driver. A run takes its edges from
// here and keys from these digests; it proves them against the claimant's
// own digests of the file as it is, which `lockfile_memos` keeps by the
// file's hash, so a warm run parses nothing and a record that is not what
// the file resolves to refuses (orchestrator/locked-digests.ts).
// `--affected` reads the base commit's copy with git: a project whose edges
// moved and a deleted project's dependants are there. `vx lock --check`
// holds it to a fresh derivation.
//
// Text, one line per project, keyed by its name and sorted, so a merge of
// two branches touches only the projects each changed. Laid out for the
// parse first, then for size (2026-11-21):
//   line 1   JSON: {"version":5,"files":[file,…],"edges":true?,"extras":{…}?}
//   then     name⇥deps⇥reach⇥digests, each list comma-separated, the
//            digests in `files` order ("" for none), empty trailing fields
//            dropped. A list with an element a comma or tab could break is
//            written as a JSON array; a name a tab could break, as a JSON
//            string. A hex digest is its 8 bytes in base64url; any other
//            digest is `=` and the string.

import path from 'node:path'
import { type PendingWrite, UserError } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'
import { type LoadReads, readOnce } from './load-reads.js'

export const DEPENDENCIES_LOCK_NAME = '.vx/dependencies.lock'
const DEPENDENCIES_LOCK_VERSION = 5
const HEX16 = /^[0-9a-f]{16}$/
const B64 = /^[A-Za-z0-9_-]{11}$/
const CONFLICT = /^(?:<{7}|={7}|>{7})(?: |$)/

/** A project's edges, as names. */
export interface LockedEdges {
  readonly deps: readonly string[]
  readonly reach: readonly string[]
}

/** The lock as read: each project's line found at once, decoded on ask. */
export interface DependenciesLock {
  /** Project names, sorted. */
  readonly names: readonly string[]
  /** Whether a `discover` plugin gave edges: with none, a `^task` has no edge source. */
  readonly edgeSource: boolean
  /** Each claimed file, sorted. */
  readonly files: readonly string[]
  /** Claimed file → each other file its digests read → its hash. */
  readonly extras: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The text, as written. */
  readonly text: string
  /** `name`'s edges; undefined for a project the lock does not hold. */
  readonly edges: (name: string) => LockedEdges | undefined
  /** `name`'s digest of file `f` ('' for none); undefined for a project the lock does not hold. */
  readonly digest: (name: string, f: number) => string | undefined
}

/** Whether `text` holds the marker lines a conflicted git merge leaves. */
export function mergeConflicted(text: string): boolean {
  return /^(?:<{7}|={7}|>{7})(?: |$)/m.test(text)
}

/**
 * What a run says of a lock a merge left conflicted: the lock is written from
 * the configs, so no hand resolution is needed.
 */
export const mergeConflictMessage = (file: string): string =>
  `${file} holds a git merge conflict: run \`vx lock\`, which writes it anew from the configs`

const invalid = (): UserError =>
  new UserError(`${DEPENDENCIES_LOCK_NAME} is invalid, run \`vx lock\``, 'VX_E_LOCK')

/** The lock for `metas`, with `files` keyed by project name as the claims answer. */
export function dependenciesLock(
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<
    string,
    { projects: Readonly<Record<string, string>>; extras?: Readonly<Record<string, string>> }
  >,
): DependenciesLock {
  const known = new Set(metas.map((m) => m.name))
  const fileNames = [...files.keys()].sort(cmp)
  const header: Record<string, unknown> = {
    version: DEPENDENCIES_LOCK_VERSION,
    files: fileNames,
  }
  if (metas.some((m) => m.deps !== undefined)) header['edges'] = true
  const extras: Record<string, Record<string, string>> = {}
  for (const f of fileNames) {
    const read = files.get(f)!.extras ?? {}
    const rels = Object.keys(read).sort(cmp)
    if (rels.length > 0) extras[f] = Object.fromEntries(rels.map((r) => [r, read[r]!]))
  }
  if (Object.keys(extras).length > 0) header['extras'] = extras
  const named = (list: readonly string[] | undefined): string[] =>
    [...new Set((list ?? []).filter((n) => known.has(n)))].sort(cmp)
  const lines = [JSON.stringify(header)]
  for (const m of [...metas].sort((a, b) => cmp(a.name, b.name))) {
    const digests = fileNames.map((f) => packed(files.get(f)!.projects[m.name] ?? ''))
    while (digests.length > 0 && digests[digests.length - 1] === '') digests.pop()
    const fields = [key(m.name), list(named(m.deps)), list(named(m.reach)), list(digests)]
    while (fields.length > 1 && fields[fields.length - 1] === '') fields.pop()
    lines.push(fields.join('\t'))
  }
  return parsed(`${lines.join('\n')}\n`)!
}

/** A digest as written: base64url for a hex one, `=` and the string for any other. */
function packed(v: string): string {
  if (v === '') return ''
  return HEX16.test(v) ? Buffer.from(v, 'hex').toString('base64url') : `=${v}`
}

function unpacked(v: string): string {
  if (v === '') return ''
  if (v.charCodeAt(0) === 61) return v.slice(1)
  if (!B64.test(v)) throw invalid()
  return Buffer.from(v, 'base64url').toString('hex')
}

/** A name as a line's key: as it is, unless a tab or newline could break it. */
function key(name: string): string {
  return /[\t\n\r]/.test(name) || name.startsWith('"') || name.startsWith('{')
    ? JSON.stringify(name)
    : name
}

/** A list as a field: comma-separated, unless an element could break it. */
function list(values: readonly string[]): string {
  return values.some((v) => /[,\t\n\r]/.test(v) || v.startsWith('['))
    ? JSON.stringify(values)
    : values.join(',')
}

function field(v: string | undefined): string[] {
  if (v === undefined || v === '') return []
  if (v.charCodeAt(0) !== 91) return v.split(',')
  const out: unknown = JSON.parse(v)
  if (!strings(out)) throw invalid()
  return out
}

/** The dependency lock's file and text, for `writeAllOrNone`. */
export function dependenciesLockWrite(root: string, lock: DependenciesLock): PendingWrite {
  return {
    file: path.join(root, DEPENDENCIES_LOCK_NAME),
    text: lock.text,
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
  const text = new TextDecoder().decode(bytes)
  const nl = text.indexOf('\n')
  let version: unknown
  try {
    version = (JSON.parse(text.slice(0, nl < 0 ? text.length : nl)) as { version?: unknown })
      ?.version
  } catch {
    return null
  }
  if (typeof version === 'number' && version > DEPENDENCIES_LOCK_VERSION)
    throw new UserError(
      `${DEPENDENCIES_LOCK_NAME} was written by a newer vx (version ${version}; this vx reads ${DEPENDENCIES_LOCK_VERSION}) — upgrade vx`,
      'VX_E_LOCK',
    )
  if (version !== DEPENDENCIES_LOCK_VERSION) return null
  return parsed(text)
}

// A committed file a merge or a bad checkout can break inside. The parse
// checks the header and that each line's name is new and in order; a line's
// fields are checked when decoded, which refuses as "invalid, run `vx lock`"
// rather than a raw TypeError at a lookup.
function parsed(text: string): DependenciesLock | null {
  try {
    const nl = text.indexOf('\n')
    if (nl < 0 || !text.endsWith('\n')) return null
    const header: unknown = JSON.parse(text.slice(0, nl))
    if (!isRecord(header)) return null
    const { files, edges, extras } = header
    if (!strings(files)) return null
    if (edges !== undefined && edges !== true) return null
    if (extras !== undefined && !extrasShaped(extras)) return null
    const names: string[] = []
    const at = new Map<string, number>()
    for (let a = nl + 1; a < text.length;) {
      const end = text.indexOf('\n', a)
      let tab = text.indexOf('\t', a)
      if (tab < 0 || tab > end) tab = end
      const raw = text.slice(a, tab)
      const name = raw.charCodeAt(0) === 34 ? (JSON.parse(raw) as unknown) : raw
      if (typeof name !== 'string' || name === '' || at.has(name)) return null
      // A conflict git's merge left: its marker lines would read as names.
      if (CONFLICT.test(name)) return null
      if (names.length > 0 && cmp(names[names.length - 1]!, name) >= 0) return null
      names.push(name)
      at.set(name, a)
      a = end + 1
    }
    const decoded = new Map<string, { edges: LockedEdges; digests: string[] }>()
    const line = (name: string) => {
      let d = decoded.get(name)
      if (d !== undefined) return d
      const start = at.get(name)
      if (start === undefined) return undefined
      const parts = text.slice(start, text.indexOf('\n', start)).split('\t')
      if (parts.length > 4) throw invalid()
      const deps = field(parts[1])
      const reach = field(parts[2])
      for (const n of [...deps, ...reach]) if (!at.has(n)) throw invalid()
      const digests = field(parts[3]).map(unpacked)
      if (digests.length > files.length) throw invalid()
      d = { edges: { deps, reach }, digests }
      decoded.set(name, d)
      return d
    }
    return {
      names,
      edgeSource: edges === true,
      files,
      extras: (extras ?? {}) as Record<string, Record<string, string>>,
      text,
      edges: (name) => line(name)?.edges,
      digest: (name, f) => {
        const d = line(name)
        return d === undefined ? undefined : (d.digests[f] ?? '')
      },
    }
  } catch {
    return null
  }
}

function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}

function extrasShaped(v: unknown): boolean {
  if (!isRecord(v)) return false
  for (const rec of Object.values(v)) {
    if (!isRecord(rec)) return false
    for (const h of Object.values(rec)) if (typeof h !== 'string') return false
  }
  return true
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The project names whose edges reach `name`. */
export function dependantsOf(lock: DependenciesLock, name: string): string[] {
  return lock.names.filter((n) => {
    const e = lock.edges(n)!
    return e.deps.includes(name) || e.reach.includes(name)
  })
}

/** `file`'s recorded extra-file hashes and each project's digest (undefined when none). */
export function recordedDigests(
  lock: DependenciesLock,
  file: string,
):
  | {
      extras: Readonly<Record<string, string>>
      has: (name: string) => boolean
      of: (name: string) => string | undefined
    }
  | undefined {
  const f = lock.files.indexOf(file)
  if (f < 0) return undefined
  return {
    extras: (Object.hasOwn(lock.extras, file) ? lock.extras[file] : undefined) ?? {},
    has: (name) => lock.digest(name, f) !== undefined,
    of: (name) => {
      const d = lock.digest(name, f)
      return d === '' ? undefined : d
    },
  }
}

/**
 * Whether `read` records what `fresh` derives here, but where a claimed
 * file's only change is the hashes of the files its digests read (same
 * extra files, an extra's hash moved): a run digests anew on
 * such an edit (`lockfileClaim`'s `lockedOnce`), and cli.md says it needs
 * no `vx lock`, yet `--check` failed every edit in a `file:` directory or a
 * patch. With every extra's hash unchanged a run keys from the record, so
 * its digests are compared.
 */
export function sameRecord(read: DependenciesLock, fresh: DependenciesLock): boolean {
  if (read.text === fresh.text) return true
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i])
  if (
    read.edgeSource !== fresh.edgeSource ||
    !same(read.names, fresh.names) ||
    !same(read.files, fresh.files)
  )
    return false
  for (const n of fresh.names) {
    const a = read.edges(n)!
    const b = fresh.edges(n)!
    if (!same(a.deps, b.deps) || !same(a.reach, b.reach)) return false
  }
  for (let f = 0; f < fresh.files.length; f++) {
    const name = fresh.files[f]!
    const was = read.extras[name] ?? {}
    const now = fresh.extras[name] ?? {}
    if (!Bun.deepEquals(Object.keys(was), Object.keys(now))) return false
    // Only the extras' hashes moved: a run digests anew, so the digests may differ.
    if (!Bun.deepEquals(was, now)) continue
    for (const n of fresh.names) if (read.digest(n, f) !== fresh.digest(n, f)) return false
  }
  return true
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
