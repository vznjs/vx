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
import { VERSION } from '../version.js'
import { validateProjectConfig } from './config-schema.js'
import { PROJECT_CONFIG_FILENAMES } from './workspace.js'

export const LOCKFILE_NAME = '.vx/projects.lock.json'
export const LOCKFILE_VERSION = 5

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
  /**
   * Root-relative POSIX directories holding their own `.vx/workspace.*`,
   * where every outer project's outputs stop. Absent when there is none, so a
   * workspace without one locks the bytes it always did.
   */
  nestedWorkspaces?: string[]
  /**
   * The plugin `project` stage as `vx lock` ran it. A run reads each
   * recorded project's config from here and runs no hook, whatever plugins
   * the workspace declares now: a mapping (`turbo()`, `nx()`) is made by
   * `vx lock` only (2026-11-11). Absent when no plugin fills the stage.
   */
  projectStage?: ProjectStageLock
  /** Written by `writeLockfile` from the bytes; never read off the object. */
  validated?: string
}

/** `Lockfile.projectStage`. */
export interface ProjectStageLock {
  /** The plugins that filled the stage, in order: `--check` names another set. */
  plugins: string[]
  /**
   * Root-relative POSIX directory → its project's config after the stage,
   * before core's default `build`: every project the stage visited, config
   * file or not.
   */
  configs: Record<string, ProjectConfig>
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
  let lock: Pooled
  try {
    lock = JSON.parse(readFileSync(lockfilePath(root), 'utf8')) as Pooled
  } catch {
    return false
  }
  if (typeof lock?.projects !== 'object' || lock.projects === null) return false
  try {
    pooledIn(lock)
  } catch {
    return true
  }
  const configs = [
    ...Object.entries(lock.projects).map(([dir, e]) => [dir, (e as LockedProject).config] as const),
    ...Object.entries(lock.projectStage?.configs ?? {}),
  ]
  for (const [dir, config] of configs) {
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
  let parsed: unknown
  let text: string
  try {
    text = await file.text()
    parsed = JSON.parse(text)
  } catch {
    throw new UserError(
      `${LOCKFILE_NAME} is not valid JSON — re-run \`vx lock\` or delete it`,
      'VX_E_LOCK',
    )
  }
  // `Array.isArray` is not redundant with the `typeof` check: `typeof [] ===
  // 'object'` and `[] !== null`, so an array sails through and the NEXT check
  // reports `unsupported version undefined` — a version diagnostic for what is
  // actually a shape problem, sending the reader to re-run `vx lock` for a file
  // that was never the right shape. `validateProjectConfig` one layer down
  // already guards this explicitly, which is what makes the omission here an
  // inconsistency rather than an oversight.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UserError(`${LOCKFILE_NAME} must be a JSON object — re-run \`vx lock\``, 'VX_E_LOCK')
  }
  const lock = parsed as {
    version?: unknown
    projects?: unknown
    nestedWorkspaces?: unknown
    projectStage?: unknown
  }
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
  // Same trap, and this one is worse than a bad message: an ARRAY of entries is
  // ACCEPTED, because `Object.entries` happily walks it — yielding a project
  // at directory "0".
  if (typeof lock.projects !== 'object' || lock.projects === null || Array.isArray(lock.projects)) {
    throw new UserError(
      `${LOCKFILE_NAME}: \`projects\` must be an object — re-run \`vx lock\``,
      'VX_E_LOCK',
    )
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
      !configShaped(config)
    ) {
      throw malformed(dir)
    }
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
  const stage = lock.projectStage
  if (stage !== undefined) {
    const { plugins, configs } = (isObj(stage) ? stage : {}) as Obj
    if (
      !Array.isArray(plugins) ||
      plugins.some((p) => typeof p !== 'string') ||
      !isObj(configs) ||
      Object.entries(configs).some(([dir, config]) => !isLockKey(dir) || !configShaped(config))
    ) {
      throw new UserError(
        `${LOCKFILE_NAME}: \`projectStage\` is malformed — re-run \`vx lock\``,
        'VX_E_LOCK',
      )
    }
  }
  pooledIn(parsed as Pooled)
  // After the pool is put back, as a task may be an index into it. A
  // string `dependsOn` was walked per character: "dependsOn b#a".
  for (const [dir, config] of configsOf(parsed as Pooled)) {
    const tasks = config.tasks as Obj | undefined
    for (const name in tasks) {
      const t = tasks[name]
      if (!isObj(t) || (t['dependsOn'] !== undefined && !Array.isArray(t['dependsOn'])))
        throw malformed(dir)
    }
  }
  digests.set(parsed as Lockfile, xxh3hex(text))
  return parsed as Lockfile
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
 * The project entries of a lock's bytes with its pool put back, or null
 * for bytes that do not parse as a lock: an entry compares across two
 * locks only once both are read the same way.
 */
export function lockEntries(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (bytes === null) return null
  try {
    const lock = JSON.parse(new TextDecoder().decode(bytes)) as Pooled
    if (typeof lock?.projects !== 'object' || lock.projects === null) return null
    pooledIn(lock)
    // A project's `project`-stage config is its entry too: a run reads it.
    const staged = lock.projectStage?.configs ?? {}
    const dirs = new Set([...Object.keys(lock.projects), ...Object.keys(staged)])
    return Object.fromEntries(
      [...dirs].map((dir) => [
        dir,
        [
          Object.hasOwn(lock.projects, dir) ? lock.projects[dir] : null,
          Object.hasOwn(staged, dir) ? staged[dir] : null,
        ],
      ]),
    )
  } catch {
    return null
  }
}

/**
 * A task or task part that two places in the lock hold alike is written once,
 * in `pool`, and each place holds its index. Each slot is one the schema
 * types as an object, so a number there can only be an index. Big
 * workspaces repeat the same tasks: 2,000 projects of five tasks read in
 * 0.71 ms against 2.62 ms, a fifth of the bytes. A run reads them shared,
 * once; a stage that edits a config in place copies it first.
 */
const POOLS = ['env', 'sandbox', 'exec', 'inputs', 'cache', 'task'] as const
type PoolName = (typeof POOLS)[number]
type Part = Exclude<PoolName, 'task'>
type Pools = Partial<Record<PoolName, unknown[]>>
type Pooled = {
  pool?: Pools
  projects: Record<string, LockedProject>
  projectStage?: ProjectStageLock
}
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const TASK_PARTS = ['exec', 'inputs', 'cache'] as const
const EXEC_PARTS = ['env', 'sandbox'] as const

/** `lock.projects` with every index replaced by the value it names, in place. */
function pooledIn(lock: Pooled): void {
  const pool = lock.pool
  delete lock.pool
  if (pool === undefined) return
  if (!isObj(pool) || Object.values(pool).some((list) => !Array.isArray(list))) {
    throw new UserError(
      `${LOCKFILE_NAME}: \`pool\` must be an object of lists — re-run \`vx lock\``,
      'VX_E_LOCK',
    )
  }
  const at = (name: PoolName, i: number): unknown => {
    const hit = pool[name]?.[i]
    if (hit === undefined) {
      throw new UserError(
        `${LOCKFILE_NAME}: no ${name} ${i} in its pool — re-run \`vx lock\``,
        'VX_E_LOCK',
      )
    }
    return hit
  }
  const parts = (o: unknown, names: readonly Part[]): void => {
    if (!isObj(o)) return
    for (const n of names) if (typeof o[n] === 'number') o[n] = at(n, o[n])
  }
  const task = (t: unknown): void => {
    parts(t, TASK_PARTS)
    if (isObj(t)) parts(t['exec'], EXEC_PARTS)
  }
  // Inner pools first: a pooled task's exec may itself be pooled.
  for (const e of pool.exec ?? []) parts(e, EXEC_PARTS)
  for (const t of pool.task ?? []) task(t)
  for (const [, config] of configsOf(lock)) {
    const tasks = (config as { tasks?: unknown } | null | undefined)?.tasks
    if (!isObj(tasks)) continue
    for (const name of Object.keys(tasks)) {
      const t = tasks[name]
      if (typeof t === 'number') tasks[name] = at('task', t)
      else task(t)
    }
  }
}

/** Every config a lock holds, by directory: each project's, then each `project`-stage one. */
function configsOf(lock: Pooled): [dir: string, config: ProjectConfig][] {
  return [
    ...Object.entries(lock.projects).map(
      ([dir, entry]) => [dir, (entry as LockedProject | null)?.config] as [string, ProjectConfig],
    ),
    ...Object.entries(lock.projectStage?.configs ?? {}),
  ]
}

/** `projects` and the stage's configs as written: each value two slots hold alike, once in `pool`. */
function pooledOut(projects: Record<string, LockedProject>, stage?: ProjectStageLock): Pooled {
  const seen = new Map<string, number>()
  const keyOf = (name: PoolName, v: Obj): string => `${name}\0${JSON.stringify(v)}`
  const count = (name: PoolName, v: unknown): void => {
    if (!isObj(v)) return
    const k = keyOf(name, v)
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const tasksOf = (config: ProjectConfig): Obj | undefined =>
    isObj(config.tasks) ? config.tasks : undefined
  const configs = [
    ...Object.values(projects).map((p) => p.config),
    ...Object.values(stage?.configs ?? {}),
  ]
  for (const config of configs) {
    for (const t of Object.values(tasksOf(config) ?? {})) {
      if (!isObj(t)) continue
      count('task', t)
      for (const n of TASK_PARTS) count(n, t[n])
      if (isObj(t['exec'])) for (const n of EXEC_PARTS) count(n, t['exec'][n])
    }
  }
  const pool: Pools = {}
  const index = new Map<string, number>()
  const out = (name: PoolName, v: unknown, inner: (v: Obj) => Obj): unknown => {
    if (!isObj(v)) return v
    const k = keyOf(name, v)
    if ((seen.get(k) ?? 0) < 2) return inner(v)
    let i = index.get(k)
    if (i === undefined) {
      const list = (pool[name] ??= [])
      index.set(k, (i = list.length))
      list.push(inner(v))
    }
    return i
  }
  const same = (v: Obj): Obj => v
  const withParts = (o: Obj, names: readonly Part[]): Obj => {
    const r = { ...o }
    for (const n of names) if (n in o) r[n] = out(n, o[n], n === 'exec' ? exec : same)
    return r
  }
  const exec = (e: Obj): Obj => withParts(e, EXEC_PARTS)
  const task = (t: Obj): Obj => withParts(t, TASK_PARTS)
  const pooled = (config: ProjectConfig): ProjectConfig => {
    const tasks = tasksOf(config)
    return tasks === undefined
      ? config
      : ({
          ...config,
          tasks: Object.fromEntries(
            Object.entries(tasks).map(([name, t]) => [name, out('task', t, task)]),
          ),
        } as ProjectConfig)
  }
  // Entries, not assignment: a directory named `__proto__` set the prototype (D-152).
  const written: Pooled = {
    projects: Object.fromEntries(
      Object.entries(projects).map(([dir, p]) => [dir, { ...p, config: pooled(p.config) }]),
    ),
  }
  if (stage !== undefined)
    written.projectStage = {
      plugins: stage.plugins,
      configs: Object.fromEntries(
        Object.entries(stage.configs).map(([dir, config]) => [dir, pooled(config)]),
      ),
    }
  const ordered: Pools = {}
  for (const n of POOLS) if (pool[n] !== undefined) ordered[n] = pool[n]
  return POOLS.some((n) => pool[n] !== undefined) ? { pool: ordered, ...written } : written
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

/**
 * Written beside its name and renamed over it: `Bun.write` truncates in
 * place, so a run, or `vx watch` woken by the write itself (item 971),
 * could read an empty or half-written lock and fail on "not valid JSON"
 * (item 972).
 */
export function writeLockfile(root: string, lock: Lockfile): Promise<void> {
  return writeAllOrNone([lockfileWrite(root, lock)], root)
}

/** The lock's file and bytes, for `writeAllOrNone`. */
export function lockfileWrite(root: string, lock: Lockfile): PendingWrite {
  // Minified: the file only vx reads, and it loads faster than pretty
  // JSON (measured, 10k projects: 15.6 ms against 22.5 ms). `vx.lock.json`
  // beside each config is the copy for people.
  const sorted = JSON.parse(JSON.stringify(lock.projects, taskKeysSorted)) as Lockfile['projects']
  const stage =
    lock.projectStage === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(lock.projectStage, taskKeysSorted)) as ProjectStageLock)
  const nested = lock.nestedWorkspaces ?? []
  const body = JSON.stringify({
    version: lock.version,
    ...(nested.length > 0 ? { nestedWorkspaces: nested } : {}),
    ...pooledOut(sorted, stage),
  })
  return {
    file: lockfilePath(root),
    text: `${body.slice(0, -1)},"validated":"${validatedDigest(body)}"}\n`,
    shown: LOCKFILE_NAME,
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
