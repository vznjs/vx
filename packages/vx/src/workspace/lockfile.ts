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
// Text, one line per record, sorted, so a merge of two branches touches only
// what each changed (2026-11-21):
//   line 1   JSON: {"version":8,"nestedWorkspaces":[…]?}
//   then     #<id>⇥<task JSON>: every task, once; its id is the xxh3 of the
//            JSON, so two projects (or two branches) holding one task write
//            one line
//   then     <name>⇥{"path":…,"file"|"by":…,"config":…}: each project, its
//            final config with each task as "#<id>"; a name a tab could break,
//            or one starting with `#`, `"` or `{`, is written as a JSON string

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
  parseDependenciesLock,
  readDependenciesLock,
} from './dependencies-lock.js'

export const LOCKFILE_NAME = '.vx/projects.lock'
const ENTRY_KEYS = new Set(['path', 'file', 'by', 'config'])

export const LOCKFILE_VERSION = 8

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
        : `${DEPENDENCIES_LOCK_NAME} is invalid, run \`vx lock\``,
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
 * tasks put back (one object per task id, shared by the projects that hold
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
  const taskAt = new Map<string, number>()
  const tasks = new Map<string, unknown>()
  const task = (ref: unknown, dir: string): unknown => {
    if (typeof ref !== 'string' || ref.charCodeAt(0) !== 35) throw malformed(dir)
    const id = ref.slice(1)
    let t = tasks.get(id)
    if (t === undefined) {
      const at = taskAt.get(id)
      if (at === undefined)
        throw new UserError(`${LOCKFILE_NAME}: no task ${ref} — re-run \`vx lock\``, 'VX_E_LOCK')
      t = JSON.parse(text.slice(at, text.indexOf('\n', at)))
      tasks.set(id, t)
    }
    return t
  }
  const names = new Set<string>()
  for (let a = nl + 1; a < text.length;) {
    let end = text.indexOf('\n', a)
    if (end < 0) end = text.length
    const tab = text.indexOf('\t', a)
    if (tab < 0 || tab > end) throw lineBroken()
    if (text.charCodeAt(a) === 35) {
      taskAt.set(text.slice(a + 1, tab), tab + 1)
      a = end + 1
      continue
    }
    const raw = text.slice(a, tab)
    const name: unknown = raw.charCodeAt(0) === 34 ? JSON.parse(raw) : raw
    const entry: unknown = JSON.parse(text.slice(tab + 1, end))
    a = end + 1
    if (typeof name !== 'string' || name === '' || names.has(name) || !isObj(entry))
      throw lineBroken()
    names.add(name)
    const dir = entry['path']
    if (typeof dir !== 'string' || !isLockKey(dir))
      throw new UserError(
        `${LOCKFILE_NAME}: "${String(dir)}" is not a directory under the workspace root — re-run \`vx lock\``,
      )
    if (Object.hasOwn(projects, dir)) throw malformed(dir)
    const { file, by, config } = entry
    if (
      Object.keys(entry).some((k) => !ENTRY_KEYS.has(k)) ||
      (file !== undefined &&
        (typeof file !== 'string' || !PROJECT_CONFIG_FILENAMES.includes(file))) ||
      (by !== undefined && (typeof by !== 'string' || file !== undefined)) ||
      (file !== undefined && config === undefined) ||
      (config !== undefined && !configShaped(config))
    )
      throw malformed(dir)
    if (isObj(config) && isObj(config['tasks'])) {
      const own = config['tasks']
      for (const t of Object.keys(own)) own[t] = task(own[t], dir)
    }
    // Entries, not assignment: a directory named `__proto__` set the prototype.
    Object.defineProperty(projects, dir, {
      value: {
        name,
        ...(file === undefined ? {} : { file }),
        ...(by === undefined ? {} : { by }),
        ...(config === undefined ? {} : { config }),
      } as LockedProject,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return { header, projects }
}

const lineBroken = (): UserError =>
  new UserError(
    `${LOCKFILE_NAME} holds a line \`vx lock\` never writes — re-run \`vx lock\``,
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
  const tasks = new Map<string, string>()
  const rows: [string, string][] = []
  for (const [dir, p] of Object.entries(lock.projects)) {
    let config =
      p.config === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(p.config, taskKeysSorted)) as Obj)
    if (config !== undefined && isObj(config['tasks'])) {
      const refs: Obj = {}
      for (const [name, t] of Object.entries(config['tasks'])) {
        const json = JSON.stringify(t)
        const id = xxh3(json).toString(36)
        tasks.set(id, json)
        Object.defineProperty(refs, name, {
          value: `#${id}`,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      config = { ...config, tasks: refs }
    }
    const entry = {
      path: dir,
      ...(p.file === undefined ? {} : { file: p.file }),
      ...(p.by === undefined ? {} : { by: p.by }),
      ...(config === undefined ? {} : { config }),
    }
    rows.push([p.name, `${lineKey(p.name)}\t${JSON.stringify(entry)}`])
  }
  const lines = [header]
  for (const id of [...tasks.keys()].sort(cmp)) lines.push(`#${id}\t${tasks.get(id)!}`)
  for (const [, line] of rows.sort((a, b) => cmp(a[0], b[0]))) lines.push(line)
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
