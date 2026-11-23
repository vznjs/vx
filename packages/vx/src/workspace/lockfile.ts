// .vx/projects.lock — frozen resolved-config lockfile.
//
// `vx lock` finds every project's vx.config.*, evaluates each in the CURRENT
// environment and freezes the resolved objects into
// `.vx/projects.lock` at the workspace root. Every run loads configs from
// it and never evaluates one; only `vx lock` writes it. See
// docs/design/config-lock-2026-06.md.
//
// Verification asymmetry (deliberate):
//   - runs TRUST the lock: no staleness check, no schema validation,
//     eval-free.
//   - `vx lock --check` AUDITS it: full re-evaluation + deep equality.
//
// Text, laid out for the parse, then size, then merges (M, 2026-11-23):
//   line 1   JSON: {"version":9,"nestedWorkspaces":[…]?}
//   then     every distinct task once, on two lines: `#<pointer>`, then
//            its JSON (keys sorted). The pointer is 7 base-36 chars of the
//            xxh3 of that JSON, so the same projects lock to the same text
//            whatever lock was there, and a merge cannot point a task at
//            JSON another branch changed (M, 2026-11-23)
//   then     each project, in xxh3-of-name order: `<name>⇥{"path":…}`
//            ("file" left out for vx.config.ts, `null` for none and no
//            plugin; its config without the tasks), then each task in name
//            order on two lines: `⇥<task>`, then its `#<pointer>`
// A name line seldom changes, so it sits between two branches'
// edits to neighbouring records and git merges both; hashed order keeps two
// new projects apart. A name a tab could break, or one starting with `#`,
// `"` or `{`, is written as a JSON string.

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import {
  keysSorted,
  type PendingWrite,
  relPosix,
  UserError,
  writeAllOrNone,
  xxh3,
  xxh3hex,
} from '../util/index.js'
import { validateProjectConfig } from './config-schema.js'
import { PROJECT_CONFIG_FILENAMES } from './workspace.js'
import {
  DEPENDENCIES_LOCK_NAME,
  type DependenciesLock,
  dependenciesLockRefusal,
  mergeConflicted,
  mergeConflictMessage,
  parseDependenciesLock,
  readDependenciesLock,
} from './dependencies-lock.js'

export const LOCKFILE_NAME = '.vx/projects.lock'
const ENTRY_KEYS = new Set(['path', 'file', 'by', 'config'])

export const LOCKFILE_VERSION = 9
/** The config file a project line names by leaving `file` out. */
const DEFAULT_FILE = 'vx.config.ts'

/**
 * One project as the lock holds it: where it ends up, not the steps there.
 * Its edges are in `.vx/dependencies.lock`.
 */
export interface LockedProject {
  /** Its name: the line's key, unique in the workspace. */
  name: string
  /** The config file's name in the directory (`vx.config.ts`); absent for a project a plugin added. */
  file?: string
  /** The plugin whose `discover` entry added it: set only on a project with no config file. */
  by?: string
  /**
   * Its config as a run reads it: evaluated, then through the plugin
   * `project` stage, JSON-normalized, before core's default `build`.
   * Absent for a config-less project no `project` plugin gave tasks.
   */
  config?: ProjectConfig
}

export interface Lockfile {
  version: number
  /** Root-relative POSIX directory (`.` for the root) → its project. */
  projects: Record<string, LockedProject>
  /**
   * Root-relative POSIX directories holding their own `.vx/workspace.*`,
   * where every outer project's outputs stop. Absent when there is none.
   */
  nestedWorkspaces?: string[]
}

export function lockfilePath(root: string): string {
  return path.join(root, LOCKFILE_NAME)
}

/** What a run says when a crash came from a hand-broken lock entry. */
export const LOCK_INVALID = `${LOCKFILE_NAME} is invalid, run \`vx lock\``

/**
 * Whether the lock holds an entry `vx lock` could not have written. Runs
 * validate no entry, so a hand-broken one crashed deep in a run with a
 * raw TypeError; asked only on that crash's path, so a run pays nothing.
 */
export function lockEntryBroken(root: string): boolean {
  let lock: Decoded
  try {
    // As `readLockfile` reads it: `Bun.file().text()` drops a leading BOM.
    lock = decoded(readFileSync(lockfilePath(root), 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    // No lock broke nothing: the crash is its own, `vx lock`'s included.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  for (const [dir, config] of configsOf(lock.projects)) {
    try {
      validateProjectConfig(config, `${LOCKFILE_NAME}: "${dir}"`, null)
    } catch {
      return true
    }
  }
  return false
}

/** What a run or `vx show` says when the lock holds no project. */
export const EMPTY_LOCK =
  'The lock holds no project — write a vx.config (`vx init`), then run `vx lock`'

/** What a run says when there is no lock to read. */
export const NO_LOCK = 'no lock: run `vx lock`'

/** Each read lock's bytes as a digest: every config a run loads from it is a function of them. */
const digests = new WeakMap<Lockfile, string>()

/** Each read lock's `.vx/dependencies.lock`, read beside it: its bytes, parsed on first ask. */
const dependencies = new WeakMap<
  Lockfile,
  { bytes: Uint8Array | null; parsed?: DependenciesLock | null }
>()

/**
 * The dependencies lock read beside `lock`: where a run's edges come from.
 * Refused when there is none or it is not this vx's shape, as a project
 * lock with no graph is one `vx lock` never wrote; undefined for a lock no
 * read made.
 */
export function lockedDependencies(lock: Lockfile): DependenciesLock | undefined {
  const read = dependencies.get(lock)
  if (read === undefined) return undefined
  read.parsed ??= parseDependenciesLock(read.bytes)
  if (read.parsed === null)
    throw new UserError(
      read.bytes === null
        ? `no ${DEPENDENCIES_LOCK_NAME}: run \`vx lock\``
        : dependenciesLockRefusal(new TextDecoder().decode(read.bytes)),
      'VX_E_LOCK',
    )
  return read.parsed
}

/** The digest of the bytes `lock` was read from; undefined for a lock no read made. */
export function lockDigest(lock: Lockfile): string | undefined {
  return digests.get(lock)
}

/**
 * Read and shape-validate `.vx/projects.lock`. Returns `null` when no lock
 * exists (the common case — the feature is opt-in). The lock is a
 * user-editable file, so this is a system boundary: malformed content
 * throws a `UserError` instead of crashing deeper in the run.
 */
export async function readLockfile(root: string): Promise<Lockfile | null> {
  // Read beside it, overlapping this read: the graph is there.
  const graph = readDependenciesLock(root)
  graph.catch(() => {})
  const file = Bun.file(lockfilePath(root))
  if (!(await file.exists())) {
    // A directory reads as no file: `--check` said "run `vx lock`", which cannot write over it.
    if (statSync(lockfilePath(root), { throwIfNoEntry: false })?.isDirectory()) {
      throw new UserError(
        `${LOCKFILE_NAME} is a directory — remove it and run \`vx lock\``,
        'VX_E_LOCK',
      )
    }
    return null
  }
  let text: string
  let read: Decoded
  try {
    text = await file.text()
    read = decoded(text)
  } catch (err) {
    if (err instanceof UserError) throw err
    throw new UserError(
      `${LOCKFILE_NAME} is not valid JSON — re-run \`vx lock\` or delete it`,
      'VX_E_LOCK',
    )
  }
  const lock = read.header
  if (lock.version !== LOCKFILE_VERSION) {
    // This vx's `vx lock` would write the older version over it.
    if (typeof lock.version === 'number' && lock.version > LOCKFILE_VERSION)
      throw new UserError(
        `${LOCKFILE_NAME} was written by a newer vx (version ${lock.version}; this vx reads ${LOCKFILE_VERSION}) — upgrade vx`,
        'VX_E_LOCK',
      )
    throw new UserError(
      `${LOCKFILE_NAME} has unsupported version ${String(lock.version)} ` +
        `(this vx expects ${LOCKFILE_VERSION}) — re-run \`vx lock\``,
      'VX_E_LOCK',
    )
  }
  const nested = lock.nestedWorkspaces
  if (
    nested !== undefined &&
    (!Array.isArray(nested) ||
      nested.some((d) => typeof d !== 'string' || d === '.' || !isLockKey(d)))
  ) {
    throw new UserError(
      `${LOCKFILE_NAME}: \`nestedWorkspaces\` must list directories under the workspace root — re-run \`vx lock\``,
      'VX_E_LOCK',
    )
  }
  // A string `dependsOn` was walked per character: "dependsOn b#a".
  for (const [dir, config] of configsOf(read.projects)) {
    const tasks = config.tasks as Obj | undefined
    for (const name in tasks) {
      const t = tasks[name]
      if (!isObj(t) || (t['dependsOn'] !== undefined && !Array.isArray(t['dependsOn'])))
        throw malformed(dir)
    }
  }
  const out: Lockfile = {
    version: LOCKFILE_VERSION,
    projects: read.projects,
    ...(nested === undefined ? {} : { nestedWorkspaces: nested as string[] }),
  }
  digests.set(out, xxh3hex(text))
  dependencies.set(out, { bytes: await graph })
  return out
}

/** A run trusts these shapes: an object with a string `name`, a `tags` list, a `tasks` object. */
function configShaped(config: unknown): boolean {
  return (
    isObj(config) &&
    (config['name'] === undefined || typeof config['name'] === 'string') &&
    (config['tags'] === undefined || Array.isArray(config['tags'])) &&
    (config['tasks'] === undefined || isObj(config['tasks']))
  )
}

const malformed = (dir: string): UserError =>
  new UserError(
    `${LOCKFILE_NAME}: entry for "${dir}" is malformed — re-run \`vx lock\``,
    'VX_E_LOCK',
  )

/**
 * The project entries of a lock's bytes, each task in place, or null for
 * bytes that do not parse as a lock: an entry compares across two locks
 * only once both are read the same way.
 */
export function lockEntries(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (bytes === null) return null
  try {
    return decoded(new TextDecoder().decode(bytes)).projects
  } catch {
    return null
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Decoded {
  header: { version?: unknown; nestedWorkspaces?: unknown }
  projects: Record<string, LockedProject>
}

/**
 * The lock in `text`: its header, and each project by directory with its
 * tasks put back (one object per pointer, shared by the projects that hold
 * it; a stage that edits a config in place copies it first). A line a
 * merge or a hand edit broke is a `UserError`; text that is no lock at all
 * throws a SyntaxError.
 */
function decoded(text: string): Decoded {
  const nl = text.indexOf('\n')
  const header: unknown = JSON.parse(nl < 0 ? text : text.slice(0, nl))
  if (!isObj(header))
    throw new UserError(
      `${LOCKFILE_NAME} must start with a JSON object — re-run \`vx lock\``,
      'VX_E_LOCK',
    )
  const projects: Record<string, LockedProject> = {}
  if (header['version'] !== LOCKFILE_VERSION || nl < 0) return { header, projects }
  const end = (a: number): number => {
    const e = text.indexOf('\n', a)
    return e < 0 ? text.length : e
  }
  // The pool: where each pointer's JSON starts, parsed on first use.
  const bodyAt = new Map<string, number>()
  let a = nl + 1
  while (text.charCodeAt(a) === 35) {
    // A pointer is `#` and 7 characters, a line of its own.
    const e = a + 8
    // A shorter one would read the next line as its own; one twice, which body wins.
    const ref = text.slice(a, e)
    if (
      text.charCodeAt(e) !== 10 ||
      text.charCodeAt(e + 1) !== 123 ||
      ref.includes('\n') ||
      bodyAt.has(ref)
    )
      throw lineBroken(text)
    bodyAt.set(ref, e + 1)
    a = end(e + 1) + 1
  }
  const tasks = new Map<string, unknown>()
  const task = (ref: string): unknown => {
    let t = tasks.get(ref)
    if (t === undefined) {
      const at = bodyAt.get(ref)
      if (at === undefined) {
        // A line cut short, not a pointer.
        if (ref.includes('\n')) throw lineBroken(text)
        throw new UserError(`${LOCKFILE_NAME}: no task ${ref} — re-run \`vx lock\``, 'VX_E_LOCK')
      }
      t = JSON.parse(text.slice(at, end(at)))
      tasks.set(ref, t)
    }
    return t
  }
  const names = new Set<string>()
  while (a < text.length) {
    const e = end(a)
    const tab = text.indexOf('\t', a)
    if (tab <= a || tab > e) throw lineBroken(text)
    const raw = text.slice(a, tab)
    const name: unknown = raw.charCodeAt(0) === 34 ? JSON.parse(raw) : raw
    const entry: unknown = JSON.parse(text.slice(tab + 1, e))
    a = e + 1
    if (typeof name !== 'string' || name === '' || names.has(name) || !isObj(entry))
      throw lineBroken(text)
    names.add(name)
    const dir = entry['path']
    if (typeof dir !== 'string' || !isLockKey(dir))
      throw new UserError(
        `${LOCKFILE_NAME}: "${String(dir)}" is not a directory under the workspace root — re-run \`vx lock\``,
      )
    if (Object.hasOwn(projects, dir)) throw malformed(dir)
    const { by } = entry
    let config = entry['config']
    // Left out: the default file, unless a plugin added the project; `null`: none.
    const named = entry['file']
    const file =
      named === null ? undefined : (named ?? (by === undefined ? DEFAULT_FILE : undefined))
    if (
      Object.keys(entry).some((k) => !ENTRY_KEYS.has(k)) ||
      (file !== undefined &&
        (typeof file !== 'string' || !PROJECT_CONFIG_FILENAMES.includes(file))) ||
      (by !== undefined && (typeof by !== 'string' || named !== undefined)) ||
      (config !== undefined && !configShaped(config))
    )
      throw malformed(dir)
    // Its tasks: a name line, then a pointer line, each. A config of tasks alone is left out.
    if (text.charCodeAt(a) === 9) {
      config ??= {}
      if (!isObj(config) || config['tasks'] !== undefined) throw malformed(dir)
      const own: Obj = {}
      let last = ''
      while (text.charCodeAt(a) === 9) {
        let ne = text.indexOf('\n', a)
        if (ne < 0) ne = text.length
        const t =
          text.charCodeAt(a + 1) === 34
            ? (JSON.parse(text.slice(a + 1, ne)) as unknown)
            : text.slice(a + 1, ne)
        // A pointer is `#` and 7 characters, a line of its own.
        const pe = ne + 9
        // In name order, as `vx lock` writes them: a name twice is a merge that kept both.
        if (
          typeof t !== 'string' ||
          t <= last ||
          text.charCodeAt(ne + 1) !== 35 ||
          (pe < text.length && text.charCodeAt(pe) !== 10)
        )
          throw lineBroken(text)
        last = t
        const v = task(text.slice(ne + 1, pe))
        // Assignment is the fast path; a task named `__proto__` would set the prototype.
        if (t === '__proto__')
          Object.defineProperty(own, t, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          })
        else own[t] = v
        a = pe + 1
      }
      config['tasks'] = own
    }
    if (file !== undefined && config === undefined) throw malformed(dir)
    const value = {
      name,
      ...(file === undefined ? {} : { file }),
      ...(by === undefined ? {} : { by }),
      ...(config === undefined ? {} : { config }),
    } as LockedProject
    // Assignment is the fast path; a directory named `__proto__` would set the prototype.
    if (dir === '__proto__')
      Object.defineProperty(projects, dir, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    else projects[dir] = value
  }
  return { header, projects }
}

const lineBroken = (text: string): UserError =>
  new UserError(
    mergeConflicted(text)
      ? mergeConflictMessage(LOCKFILE_NAME)
      : `${LOCKFILE_NAME} holds a line \`vx lock\` never writes — re-run \`vx lock\``,
    'VX_E_LOCK',
  )

/** Every config a lock holds, by directory. */
function configsOf(
  projects: Record<string, LockedProject>,
): [dir: string, config: ProjectConfig][] {
  const out: [string, ProjectConfig][] = []
  for (const [dir, entry] of Object.entries(projects)) {
    if (entry.config !== undefined) out.push([dir, entry.config])
  }
  return out
}

/** A name as a line's key: as it is, unless a tab could break it or it reads as another line's. */
function lineKey(name: string): string {
  return /[\t\n\r]/.test(name) || /^[#"{]/.test(name) ? JSON.stringify(name) : name
}

/** A task name as its line holds it, after the tab. */
function taskKey(name: string): string {
  return /[\t\n\r]/.test(name) || name.startsWith('"') ? JSON.stringify(name) : name
}

/**
 * Written beside its name and renamed over it: `Bun.write` truncates in place,
 * so a run, or `vx watch` woken by the write itself, could read an empty or
 * half-written lock and fail on "not valid JSON".
 */
export function writeLockfile(root: string, lock: Lockfile): Promise<void> {
  return writeAllOrNone([lockfileWrite(root, lock)], root)
}

/** The lock's file and text, for `writeAllOrNone`. */
export function lockfileWrite(root: string, lock: Lockfile): PendingWrite {
  // `vx.lock.json` beside each config is the copy for people.
  const nested = lock.nestedWorkspaces ?? []
  const header = JSON.stringify({
    version: lock.version,
    ...(nested.length > 0 ? { nestedWorkspaces: nested } : {}),
  })
  const jsons = new Set<string>()
  const rows: { name: string; line: string; tasks: [name: string, json: string][] }[] = []
  for (const [dir, p] of Object.entries(lock.projects)) {
    const config =
      p.config === undefined ? undefined : (JSON.parse(JSON.stringify(p.config)) as Obj)
    const own = config !== undefined && isObj(config['tasks']) ? config['tasks'] : undefined
    const names = own === undefined ? [] : Object.keys(own).sort(cmp)
    if (names.length > 0) delete config!['tasks']
    const bare = names.length > 0 && Object.keys(config!).length === 0
    const tasks: [string, string][] = []
    for (const t of names) {
      const json = JSON.stringify(keysSorted(own![t]))
      jsons.add(json)
      tasks.push([t, json])
    }
    const entry = {
      path: dir,
      ...(p.file === DEFAULT_FILE
        ? {}
        : p.file !== undefined
          ? { file: p.file }
          : p.by === undefined
            ? { file: null }
            : {}),
      ...(p.by === undefined ? {} : { by: p.by }),
      ...(config === undefined || bare ? {} : { config }),
    }
    rows.push({ name: p.name, line: `${lineKey(p.name)}\t${JSON.stringify(entry)}`, tasks })
  }
  // In JSON order, so two JSONs whose pointers collide salt the same way
  // every time.
  const pool = new Map<string, string>()
  const refOf = new Map<string, string>()
  for (const json of [...jsons].sort(cmp)) {
    let ref: string
    for (let salt = 0; ; salt++) {
      const h = xxh3(salt === 0 ? json : `${salt}\0${json}`)
      ref = `#${h.toString(36).padStart(7, '0').slice(0, 7)}`
      if (!pool.has(ref)) break
    }
    pool.set(ref, json)
    refOf.set(json, ref)
  }
  const lines = [header]
  for (const ref of [...pool.keys()].sort(cmp)) lines.push(ref, pool.get(ref)!)
  const order = rows
    .map((r) => [xxh3(r.name), r] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : cmp(x[1].name, y[1].name)))
  for (const [, r] of order) {
    lines.push(r.line)
    for (const [t, json] of r.tasks) lines.push(`\t${taskKey(t)}`, refOf.get(json)!)
  }
  return { file: lockfilePath(root), text: `${lines.join('\n')}\n`, shown: LOCKFILE_NAME }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
    // Own entries only: `constructor` read Object's, "locked" at undefined.
    const entry = Object.hasOwn(lock.projects, dir) ? lock.projects[dir] : undefined
    if (entry?.config === undefined) {
      throw new UserError(
        `${LOCKFILE_NAME} has no entry for "${meta.name}" (${relPosix(root, meta.configPath)}) — ` +
          'run `vx lock`',
        'VX_E_LOCK',
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
