// Every vx setting, once: its path is its `.vx/workspace` key, and its
// environment variable and flag are derived from that path. Parsing,
// validation, `vx info`'s settings view and the docs' settings tables all
// read this list (`tests/settings.test.ts` holds src and docs to it).

import {
  machineParallelism,
  MAX_TIMEOUT_MS,
  parseDecimalInt,
  parseDuration,
  parseSize,
  UserError,
} from './util/index.js'

export type SettingKind =
  | { readonly type: 'int'; readonly min: number }
  | { readonly type: 'concurrency' }
  // `zero`: 0 is a value ("wait for nothing not already done"), not a typo.
  | { readonly type: 'duration'; readonly timer?: true; readonly zero?: true }
  | { readonly type: 'size' }
  | { readonly type: 'bool' }
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'string' }

export interface Setting {
  /** The `.vx/workspace` path (`run.timeout`); env and flag derive from it. */
  readonly path: string
  readonly kind: SettingKind
  /** The built-in, as the docs print it. */
  readonly default: string
  /** One line for the docs table. */
  readonly doc: string
  /** The verb whose flag sets it (`vx run --timeout`); none → env and config only. */
  readonly flag?: { readonly verb: 'run' | 'watch'; readonly name: string }
  /** The task field that overrides it, and beats every run-level source. */
  readonly task?: string
  /** False: read before `.vx/workspace` loads, so flag and env only. */
  readonly config?: false
  /** False: `.vx/workspace` only, no variable. */
  readonly env?: false
}

const SCHEDULES = ['most-work', 'critical-path', 'direct-dependents', 'ready-order'] as const

export const SETTINGS: readonly Setting[] = [
  {
    path: 'run.concurrency',
    kind: { type: 'concurrency' },
    default: 'the cores this process may use',
    doc: "Tasks at once: a positive integer, or a share of the cores (`'50%'`).",
    flag: { verb: 'run', name: '--concurrency' },
  },
  {
    path: 'run.schedule',
    kind: { type: 'enum', values: SCHEDULES },
    default: 'most-work',
    doc: 'Which ready task starts first when there are more than workers.',
    flag: { verb: 'run', name: '--schedule' },
  },
  {
    path: 'run.affectedBase',
    kind: { type: 'string' },
    default: 'origin/HEAD, then the trunk, else HEAD~1',
    doc: 'The git ref a bare `--affected` compares with.',
  },
  {
    path: 'run.branch',
    kind: { type: 'string' },
    default: "git's branch, then the CI provider's",
    doc: 'The branch a run records in its history and forecasts from. Flag and env only: a committed branch would be wrong on every other branch.',
    flag: { verb: 'run', name: '--branch' },
    config: false,
  },
  {
    path: 'run.timeout',
    kind: { type: 'duration', timer: true },
    default: 'none',
    doc: "A task's time limit, for tasks without their own `exec.timeout` (`'30m'`).",
    flag: { verb: 'run', name: '--timeout' },
    task: 'exec.timeout',
  },
  {
    path: 'run.retries',
    kind: { type: 'int', min: 0 },
    default: '0',
    doc: 'Re-runs of a failed task, for tasks without their own `exec.retries`.',
    flag: { verb: 'run', name: '--retries' },
    task: 'exec.retries',
  },
  {
    path: 'run.continue',
    kind: { type: 'enum', values: ['never', 'deps-ok', 'always'] },
    default: 'deps-ok',
    doc: 'What a failed task takes down: `never` stops the run, `deps-ok` skips its dependents, `always` runs them too.',
    flag: { verb: 'run', name: '--continue' },
  },
  {
    path: 'run.outputLogs',
    kind: { type: 'enum', values: ['full', 'errors-only', 'hash-only', 'none'] },
    default: '`full` on CI, else by what the run selects',
    doc: 'Which task output the run prints. Chosen before the workspace loads, so flag and env only.',
    flag: { verb: 'run', name: '--output-logs' },
    config: false,
  },
  {
    path: 'run.killGrace',
    kind: { type: 'duration', timer: true },
    default: '2s',
    doc: 'How long a task that ignores SIGTERM gets before SIGKILL.',
    flag: { verb: 'run', name: '--kill-grace' },
  },
  {
    path: 'run.teardownTimeout',
    kind: { type: 'duration', timer: true, zero: true },
    default: '3s',
    doc: "The bound on each plugin's end-of-run flush and teardown.",
    flag: { verb: 'run', name: '--teardown-timeout' },
  },
  {
    path: 'run.readyNotice',
    kind: { type: 'duration', timer: true },
    default: '10s',
    doc: 'How long a persistent task may take to match `readyWhen` before vx says it waits.',
    flag: { verb: 'run', name: '--ready-notice' },
  },
  {
    path: 'run.rules.exclusiveOutputs',
    kind: { type: 'bool' },
    default: 'true',
    doc: 'Refuse two tasks whose outputs overlap even when an edge orders them.',
  },
  {
    path: 'run.rules.upfrontKeys',
    kind: { type: 'bool' },
    default: 'true',
    doc: "Refuse a task whose inputs can match another task's outputs.",
  },
  {
    path: 'cache.dir',
    kind: { type: 'string' },
    default: '.vx/cache, entries in ~/.vx/<repo>/cache',
    doc: 'Where the cache lives, relative to the workspace root; named, it holds the whole cache.',
    flag: { verb: 'run', name: '--cache-dir' },
  },
  {
    path: 'cache.retention.maxSize',
    kind: { type: 'size' },
    default: 'none',
    doc: "Evict least-recently-used entries at each run's end until the cache is under this (`'10GB'`).",
  },
  {
    path: 'cache.retention.olderThan',
    kind: { type: 'duration' },
    default: 'none',
    doc: "Evict entries unused for this long at each run's end (`'30d'`).",
  },
  {
    path: 'cache.policy',
    kind: { type: 'string' },
    default: 'every layer reads and writes',
    doc: "Which layers a run reads and writes (`'local:rw,remote:r'`); `--no-cache` and `--force` apply on top.",
    flag: { verb: 'run', name: '--cache-policy' },
  },
  {
    path: 'cache.scope',
    kind: { type: 'string' },
    default: 'none (the default keys)',
    doc: "Where cache writes land (`'pr-123'`): reads try the default key, then the scope's.",
    flag: { verb: 'run', name: '--cache-scope' },
  },
  {
    path: 'cache.download',
    kind: { type: 'enum', values: ['all', 'toplevel', 'none'] },
    default: 'all',
    doc: 'Which remote hits land on disk: every one, only the requested tasks, or none.',
    flag: { verb: 'run', name: '--cache-download' },
  },
  {
    path: 'cache.inputStability.strategy',
    kind: { type: 'enum', values: ['immutable', 'mutable', 'unchecked'] },
    default: 'immutable',
    doc: 'What a write to an input during the command means for the save, for tasks without their own.',
    task: 'cache.inputStability.strategy',
  },
  {
    path: 'cache.inputStability.severity',
    kind: { type: 'enum', values: ['warn', 'error'] },
    default: 'warn',
    doc: 'Whether a skipped save warns or fails the task, for tasks without their own.',
    task: 'cache.inputStability.severity',
  },
  {
    path: 'cache.outputs.clean',
    kind: { type: 'bool' },
    default: 'true',
    doc: "Remove a task's declared outputs before it runs on a miss, for tasks without their own.",
    task: 'cache.outputs.clean',
    env: false,
  },
  {
    path: 'lock.reviewFiles',
    kind: { type: 'bool' },
    default: 'true',
    doc: "`vx lock` writes each project's resolved config, pretty, to `vx.lock.json` beside its `vx.config`, for review; vx never reads it.",
  },
  {
    path: 'watch.poll',
    kind: { type: 'bool' },
    default: 'false',
    doc: 'Poll for changes from the start instead of the OS watcher.',
    flag: { verb: 'watch', name: '--poll' },
  },
  {
    path: 'config.workerTimeout',
    kind: { type: 'duration', timer: true },
    default: '30s',
    doc: 'How long one config evaluation may take.',
    config: false,
  },
  {
    path: 'debug.timing',
    kind: { type: 'bool' },
    default: 'false',
    doc: "Print the run's stage timings to stderr.",
    config: false,
  },
  {
    path: 'debug.dumpable',
    kind: { type: 'bool' },
    default: 'false',
    doc: 'Linux: keep vx dumpable, so strace or a debugger can read its memory and `/proc/<pid>/fd`, and an unsandboxed task its env.',
    config: false,
  },
]

/** The `.vx/workspace` groups that hold settings; `plugins` is the other key. */
export const SETTING_GROUPS = ['run', 'cache', 'lock', 'watch'] as const

const BY_PATH = new Map(SETTINGS.map((s) => [s.path, s]))

export function setting(path: string): Setting {
  return BY_PATH.get(path)!
}

/** `run.killGrace` → `VX_RUN_KILL_GRACE`. */
export function envName(path: string): string {
  return `VX_${path
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/\./g, '_')
    .toUpperCase()}`
}

/** What a value of this kind looks like, for an error. */
export function kindHint(kind: SettingKind): string {
  switch (kind.type) {
    case 'int':
      return kind.min === 0 ? 'a non-negative integer' : `an integer ≥ ${kind.min}`
    case 'concurrency':
      return "a positive integer, or a share of the cores like '50%'"
    case 'duration':
      // A timer past 2^31-1 ms fires at once, so "no limit" is no value.
      return kind.timer === true
        ? "a duration like '500ms', '30s' or '5m', at most 24 days"
        : "a duration like '45s', '12h' or '30d'"
    case 'size':
      return "a size like '500MB' or '10GB'"
    case 'bool':
      return 'true or false'
    case 'enum':
      return `one of ${kind.values.map((v) => `'${v}'`).join(', ')}`
    case 'string':
      return 'a non-blank string'
  }
}

/**
 * A positive decimal integer, or `<n>%` of the cores this process may use
 * (`50%` on eight cores is 4, never below 1; over 100% is allowed for
 * I/O-bound work; a container's CPU quota caps the count the way it caps
 * the default), resolved here so the run sees one number and the summary
 * says what it ran with.
 */
export function parseConcurrency(v: unknown, cpus = machineParallelism()): number | null {
  if (typeof v !== 'string') return null
  const pct = /^(\d+)%$/.exec(v)
  if (pct) {
    const n = parseDecimalInt(pct[1]!)
    if (n === null || n < 1) return null
    return Math.max(1, Math.round((Math.max(1, cpus) * n) / 100))
  }
  const n = parseDecimalInt(v)
  return n === null || n < 1 ? null : n
}

/**
 * A setting's value, or null when `raw` is not one. Durations come back in
 * ms, sizes in bytes and a share of the cores as a count; the rest as typed.
 */
export function parseSettingValue(kind: SettingKind, raw: unknown): unknown {
  switch (kind.type) {
    case 'int': {
      const n =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? parseDecimalInt(raw) : null
      return n !== null && Number.isSafeInteger(n) && n >= kind.min ? n : null
    }
    case 'concurrency':
      return parseConcurrency(typeof raw === 'number' ? String(raw) : raw)
    case 'duration': {
      const n = typeof raw === 'string' ? parseDuration(raw) : null
      if (n === null || (n === 0 && kind.zero !== true)) return null
      return kind.timer === true && n > MAX_TIMEOUT_MS ? null : n
    }
    case 'size':
      return typeof raw === 'string' ? parseSize(raw) : null
    case 'bool':
      if (typeof raw === 'boolean') return raw
      return raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : null
    case 'enum':
      return typeof raw === 'string' && kind.values.includes(raw) ? raw : null
    case 'string':
      return typeof raw === 'string' && raw.trim() !== '' ? raw : null
  }
}

/**
 * Why `raw` from `where` (a variable, a flag, a config field) is refused
 * for the setting at `path`; `got` is `raw` as the message quotes it. A
 * bare number for a duration names the unit it lacks, and a timer past the
 * platform's range says it would fire at once rather than never.
 */
export function settingRefusal(
  path: string,
  where: string,
  raw: unknown,
  got = String(raw),
): string {
  const { kind } = setting(path)
  if (kind.type === 'duration') {
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^\d+$/.test(raw)
          ? Number(raw)
          : null
    if (n !== null && Number.isSafeInteger(n) && n > 0) {
      return `${where} takes a duration with its unit, like '${n}ms' or '${Math.max(1, Math.round(n / 1000))}s' (got ${got})`
    }
    const ms = typeof raw === 'string' ? parseDuration(raw) : null
    if (kind.timer === true && ms !== null && ms > MAX_TIMEOUT_MS) {
      return (
        `${where} of ${got} exceeds the maximum timer delay (${MAX_TIMEOUT_MS} ms, ~24.8 days): ` +
        'a longer timer fires at once, it does not mean "no limit"' +
        (path === 'run.timeout' ? ' — omit it for no limit' : '')
      )
    }
  }
  return `${where} must be ${kindHint(kind)} (got ${got})`
}

/** A setting's environment value, parsed; undefined when unset or empty. */
export function settingEnv(path: string, env: NodeJS.ProcessEnv = process.env): unknown {
  const { kind, env: read } = setting(path)
  if (read === false) return undefined
  const name = envName(path)
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const v = parseSettingValue(kind, raw)
  if (v === null) throw new UserError(settingRefusal(path, name, raw), 'VX_E_USAGE')
  return v
}

/** Validate every set setting variable once, so a deep reader can trust what it reads. */
export function checkSettingsEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const s of SETTINGS) settingEnv(s.path, env)
}

/** Where a resolved setting came from. */
export type SettingSource = 'flag' | 'env' | 'workspace' | 'default'

/** `config` at `path` (`run.timeout` → `config.run?.timeout`). */
export function atPath(config: unknown, path: string): unknown {
  let v: unknown = config
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

/**
 * A run-level setting: the flag's value, else the environment's, else the
 * workspace's, parsed; undefined with its default. A task override is
 * applied where the task runs, above all three.
 */
export function resolveSetting(
  path: string,
  workspace: unknown,
  flag?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { value: unknown; source: SettingSource } {
  if (flag !== undefined) return { value: flag, source: 'flag' }
  const e = settingEnv(path, env)
  if (e !== undefined) return { value: e, source: 'env' }
  const w = setting(path).config === false ? undefined : atPath(workspace, path)
  if (w !== undefined)
    return { value: parseSettingValue(setting(path).kind, w), source: 'workspace' }
  return { value: undefined, source: 'default' }
}

/** `run.rules`, each from its variable, else the workspace; unset ones stay on. */
export function runRules(workspace: unknown): {
  exclusiveOutputs?: boolean
  upfrontKeys?: boolean
} {
  const out: { exclusiveOutputs?: boolean; upfrontKeys?: boolean } = {}
  for (const rule of ['exclusiveOutputs', 'upfrontKeys'] as const) {
    const { value } = resolveSetting(`run.rules.${rule}`, workspace)
    if (value !== undefined) out[rule] = value as boolean
  }
  return out
}
