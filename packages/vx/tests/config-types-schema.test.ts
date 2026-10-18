// The config types and the validator name the same keys at every level.
// `defineProject` / `defineWorkspace` type an undeclared key `never`
// (D-69, D-70), so a key the validator accepts but the type lacks is a
// config that loads and does not type-check, and the reverse is one that
// type-checks and is refused at load (D-71). Each list below is held to
// the TYPE by the type-checker (`satisfies` for every entry, `Exhaustive`
// for every key) and to the VALIDATOR by its own refusal, which names
// what it allows when handed a key it does not know.
import { describe, expect, it } from 'bun:test'
import type {
  CacheConfig,
  InputsConfig,
  CacheSettings,
  RunSettings,
  WatchSettings,
  CacheOutputs,
  InputStability,
  ExecConfig,
  ExecEnv,
  PersistentConfig,
  ProjectConfig,
  SandboxConfig,
  SandboxDenials,
  SandboxGrants,
  SandboxIgnore,
  TaskConfig,
  WorkspaceConfig,
  LockSettings,
} from '../src/config.js'
import { defineProject } from '../src/config.js'
import { validateProjectConfig, validateWorkspace } from '../src/workspace/index.js'

type Keys<T> = Extract<keyof T, string>
/** `true` only when `L` names every key of `T`; a missing one is a type error. */
type Exhaustive<T, L extends readonly string[]> = [Exclude<Keys<T>, L[number]>] extends [never]
  ? true
  : ['missing from the list:', Exclude<Keys<T>, L[number]>]

const WORKSPACE = [
  'baseBranch',
  'cache',
  'lock',
  'plugins',
  'run',
  'watch',
] as const satisfies readonly Keys<WorkspaceConfig>[]
const RUN = [
  'concurrency',
  'continue',
  'retries',
  'rules',
  'schedule',
  'timeout',
] as const satisfies readonly Keys<RunSettings>[]
const RULES = ['dependencies', 'exclusiveOutputs'] as const satisfies readonly Keys<
  NonNullable<RunSettings['rules']>
>[]
const WATCH = ['poll'] as const satisfies readonly Keys<WatchSettings>[]
const LOCK = ['reviewFiles'] as const satisfies readonly Keys<LockSettings>[]
const PROJECT = ['name', 'tags', 'tasks'] as const satisfies readonly Keys<ProjectConfig>[]
const TASK = [
  'cache',
  'dependsOn',
  'description',
  'exec',
  'inputs',
] as const satisfies readonly Keys<TaskConfig>[]
const EXEC = [
  'command',
  'env',
  'interactive',
  'persistent',
  'remote',
  'retries',
  'sandbox',
  'timeout',
] as const satisfies readonly Keys<ExecConfig>[]
const ENV = ['define', 'passThrough', 'secret'] as const satisfies readonly Keys<ExecEnv>[]
const CACHE = ['outputs', 'inputStability'] as const satisfies readonly Keys<CacheConfig>[]
const STABILITY = ['severity', 'strategy'] as const satisfies readonly Keys<InputStability>[]
const INPUTS = [
  'env',
  'files',
  'runtime',
  'tasks',
  'workspaceFiles',
  'workspaceRuntime',
] as const satisfies readonly Keys<InputsConfig>[]
const OUTPUTS = [
  'clean',
  'files',
  'workspaceFiles',
] as const satisfies readonly Keys<CacheOutputs>[]
const RETENTION = ['maxSize', 'olderThan'] as const satisfies readonly Keys<
  NonNullable<CacheSettings['retention']>
>[]
const WORKSPACE_CACHE = [
  'concurrency',
  'dir',
  'download',
  'inputStability',
  'outputs',
  'policy',
  'retention',
  'store',
  'upload',
] as const satisfies readonly Keys<CacheSettings>[]
const STORE = ['decompress', 'verify'] as const satisfies readonly Keys<
  NonNullable<CacheSettings['store']>
>[]
const CONCURRENCY = ['download', 'restore', 'upload'] as const satisfies readonly Keys<
  NonNullable<CacheSettings['concurrency']>
>[]
const UPLOAD = ['failures'] as const satisfies readonly Keys<NonNullable<CacheSettings['upload']>>[]
const PERSISTENT = ['readyWhen'] as const satisfies readonly Keys<PersistentConfig>[]
const SANDBOX = [
  'allow',
  'deny',
  'ignore',
  'weakerNetworkIsolation',
  'weakerWhenNested',
] as const satisfies readonly Keys<SandboxConfig>[]
const GRANTS = [
  'gitConfig',
  'localBinding',
  'machLookup',
  'network',
  'pty',
  'read',
  'systemInfo',
  'unixSockets',
  'write',
] as const satisfies readonly Keys<SandboxGrants>[]
const DENIALS = ['network'] as const satisfies readonly Keys<SandboxDenials>[]
const IGNORES = [
  'network',
  'read',
  'systemInfo',
  'write',
] as const satisfies readonly Keys<SandboxIgnore>[]

const exhaustive: [
  Exhaustive<WorkspaceConfig, typeof WORKSPACE>,
  Exhaustive<RunSettings, typeof RUN>,
  Exhaustive<NonNullable<RunSettings['rules']>, typeof RULES>,
  Exhaustive<WatchSettings, typeof WATCH>,
  Exhaustive<LockSettings, typeof LOCK>,
  Exhaustive<ProjectConfig, typeof PROJECT>,
  Exhaustive<TaskConfig, typeof TASK>,
  Exhaustive<ExecConfig, typeof EXEC>,
  Exhaustive<ExecEnv, typeof ENV>,
  Exhaustive<CacheConfig, typeof CACHE>,
  Exhaustive<InputsConfig, typeof INPUTS>,
  Exhaustive<CacheOutputs, typeof OUTPUTS>,
  Exhaustive<InputStability, typeof STABILITY>,
  Exhaustive<NonNullable<CacheSettings['retention']>, typeof RETENTION>,
  Exhaustive<CacheSettings, typeof WORKSPACE_CACHE>,
  Exhaustive<NonNullable<CacheSettings['upload']>, typeof UPLOAD>,
  Exhaustive<NonNullable<CacheSettings['store']>, typeof STORE>,
  Exhaustive<NonNullable<CacheSettings['concurrency']>, typeof CONCURRENCY>,
  Exhaustive<PersistentConfig, typeof PERSISTENT>,
  Exhaustive<SandboxConfig, typeof SANDBOX>,
  Exhaustive<SandboxGrants, typeof GRANTS>,
  Exhaustive<SandboxDenials, typeof DENIALS>,
  Exhaustive<SandboxIgnore, typeof IGNORES>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
]
void exhaustive

/** What the validator allows where the call puts a key it does not know. */
function allowed(validate: () => void): string[] {
  try {
    validate()
  } catch (err) {
    const m = /\(allowed: ([^)]*)\)/.exec((err as Error).message)
    if (m !== null) return m[1]!.split(', ')
    throw err
  }
  throw new Error('the validator accepted an unknown key')
}
const X = { zzUnknown: 1 }
const task = (extra: object) => ({ tasks: { t: { exec: { command: 'true' }, ...extra } } })
const exec = (extra: object) => ({ tasks: { t: { exec: { command: 'true', ...extra } } } })

describe('the config types and the validator agree on every level (D-71)', () => {
  it.each([
    ['workspace', WORKSPACE, () => validateWorkspace({ ...X } as never, 'w')],
    ['project', PROJECT, () => validateProjectConfig({ tasks: {}, ...X } as never, 'p')],
    ['task', TASK, () => validateProjectConfig(task(X) as never, 'p')],
    [
      'exec',
      EXEC,
      () =>
        validateProjectConfig({ tasks: { t: { exec: { command: 'true', ...X } } } } as never, 'p'),
    ],
    [
      'exec.env',
      ENV,
      () =>
        validateProjectConfig(
          { tasks: { t: { exec: { command: 'true', env: { ...X } } } } } as never,
          'p',
        ),
    ],
    [
      'cache',
      CACHE,
      () =>
        validateProjectConfig(
          task({ inputs: { files: [] }, cache: { outputs: { files: [] }, ...X } }) as never,
          'p',
        ),
    ],
    [
      'inputs',
      INPUTS,
      () =>
        validateProjectConfig(
          task({ inputs: { files: [], ...X }, cache: { outputs: { files: [] } } }) as never,
          'p',
        ),
    ],
    [
      'cache.outputs',
      OUTPUTS,
      () =>
        validateProjectConfig(
          task({ inputs: { files: [] }, cache: { outputs: { files: [], ...X } } }) as never,
          'p',
        ),
    ],
    [
      'cache.inputStability',
      STABILITY,
      () =>
        validateProjectConfig(
          task({
            inputs: { files: [] },
            cache: { outputs: { files: [] }, inputStability: X },
          }) as never,
          'p',
        ),
    ],
    ['run', RUN, () => validateWorkspace({ run: { ...X } } as never, 'w')],
    ['run.rules', RULES, () => validateWorkspace({ run: { rules: X } } as never, 'w')],
    ['watch', WATCH, () => validateWorkspace({ watch: { ...X } } as never, 'w')],
    ['lock', LOCK, () => validateWorkspace({ lock: { ...X } } as never, 'w')],
    [
      'cache.inputStability (workspace)',
      STABILITY,
      () => validateWorkspace({ cache: { inputStability: X } } as never, 'w'),
    ],
    [
      'cache.retention',
      RETENTION,
      () => validateWorkspace({ cache: { retention: { ...X } } } as never, 'w'),
    ],
    [
      'cache.concurrency',
      CONCURRENCY,
      () => validateWorkspace({ cache: { concurrency: { ...X } } } as never, 'w'),
    ],
    ['cache.store', STORE, () => validateWorkspace({ cache: { store: { ...X } } } as never, 'w')],
    [
      'cache.upload',
      UPLOAD,
      () => validateWorkspace({ cache: { upload: { ...X } } } as never, 'w'),
    ],
    [
      'cache (workspace)',
      WORKSPACE_CACHE,
      () => validateWorkspace({ cache: { ...X } } as never, 'w'),
    ],
    [
      'exec.persistent',
      PERSISTENT,
      () => validateProjectConfig(exec({ persistent: X }) as never, 'p'),
    ],
    ['exec.sandbox', SANDBOX, () => validateProjectConfig(exec({ sandbox: X }) as never, 'p')],
    [
      'exec.sandbox.allow',
      GRANTS,
      () => validateProjectConfig(exec({ sandbox: { allow: X } }) as never, 'p'),
    ],
    [
      'exec.sandbox.deny',
      DENIALS,
      () => validateProjectConfig(exec({ sandbox: { deny: X } }) as never, 'p'),
    ],
    [
      'exec.sandbox.ignore',
      IGNORES,
      () => validateProjectConfig(exec({ sandbox: { ignore: X } }) as never, 'p'),
    ],
  ] as const)('%s', (_, keys, validate) => {
    expect(allowed(validate)).toEqual([...keys].sort())
  })
})

// Shared lists are how configs compose (no named inputs, by design), and a
// shared list is usually `as const`: every array field takes a readonly one.
// The type-checker holds this row; `bun test` alone cannot fail it.
describe('a config built from readonly lists type-checks and loads', () => {
  const SRC = ['src/**', 'package.json'] as const
  const NAMES = ['CI'] as const
  const PATHS = ['/opt/tool'] as const
  const config = defineProject({
    tags: ['web'] as const,
    tasks: {
      build: {
        dependsOn: ['^build'] as const,
        exec: {
          command: 'tsc',
          env: { passThrough: NAMES, secret: NAMES },
          sandbox: {
            allow: {
              read: PATHS,
              write: PATHS,
              network: ['example.com'] as const,
              unixSockets: PATHS,
              localBinding: [3000] as const,
              systemInfo: ['hw.ncpu'] as const,
              machLookup: ['com.apple.x'] as const,
            },
            deny: { network: ['example.org'] as const },
            ignore: {
              read: PATHS,
              write: PATHS,
              systemInfo: ['x'] as const,
              network: ['y'] as const,
            },
          },
        },
        inputs: {
          files: SRC,
          workspaceFiles: ['tsconfig.base.json'] as const,
          env: NAMES,
          tasks: ['^build'] as const,
          runtime: ['node -v'] as const,
          workspaceRuntime: ['git -v'] as const,
        },
        cache: {
          outputs: { files: ['dist/**'] as const, workspaceFiles: ['out/x'] as const },
        },
      },
    },
  })
  it('loads', () => {
    expect(() => validateProjectConfig(config, '/ws/a/vx.config.ts')).not.toThrow()
  })
})
