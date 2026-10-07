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
  CacheInputs,
  CacheOutputs,
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
} from '../src/config.js'
import { validateProjectConfig, validateWorkspace } from '../src/workspace/index.js'

type Keys<T> = Extract<keyof T, string>
/** `true` only when `L` names every key of `T`; a missing one is a type error. */
type Exhaustive<T, L extends readonly string[]> = [Exclude<Keys<T>, L[number]>] extends [never]
  ? true
  : ['missing from the list:', Exclude<Keys<T>, L[number]>]

const WORKSPACE = [
  'affectedBase',
  'cacheDir',
  'cacheRetention',
  'cacheScope',
  'concurrency',
  'plugins',
  'rules',
  'timeout',
] as const satisfies readonly Keys<WorkspaceConfig>[]
const PROJECT = ['tags', 'tasks'] as const satisfies readonly Keys<ProjectConfig>[]
const TASK = [
  'cache',
  'dependsOn',
  'description',
  'exec',
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
const CACHE = ['inputs', 'outputs'] as const satisfies readonly Keys<CacheConfig>[]
const INPUTS = [
  'env',
  'files',
  'runtime',
  'tasks',
  'workspaceFiles',
  'workspaceRuntime',
] as const satisfies readonly Keys<CacheInputs>[]
const OUTPUTS = ['files', 'workspaceFiles'] as const satisfies readonly Keys<CacheOutputs>[]
const RETENTION = ['maxSize', 'olderThan'] as const satisfies readonly Keys<
  NonNullable<WorkspaceConfig['cacheRetention']>
>[]
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
  Exhaustive<ProjectConfig, typeof PROJECT>,
  Exhaustive<TaskConfig, typeof TASK>,
  Exhaustive<ExecConfig, typeof EXEC>,
  Exhaustive<ExecEnv, typeof ENV>,
  Exhaustive<CacheConfig, typeof CACHE>,
  Exhaustive<CacheInputs, typeof INPUTS>,
  Exhaustive<CacheOutputs, typeof OUTPUTS>,
  Exhaustive<NonNullable<WorkspaceConfig['cacheRetention']>, typeof RETENTION>,
  Exhaustive<PersistentConfig, typeof PERSISTENT>,
  Exhaustive<SandboxConfig, typeof SANDBOX>,
  Exhaustive<SandboxGrants, typeof GRANTS>,
  Exhaustive<SandboxDenials, typeof DENIALS>,
  Exhaustive<SandboxIgnore, typeof IGNORES>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true]
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
          task({ cache: { inputs: { files: [] }, outputs: { files: [] }, ...X } }) as never,
          'p',
        ),
    ],
    [
      'cache.inputs',
      INPUTS,
      () =>
        validateProjectConfig(
          task({ cache: { inputs: { files: [], ...X }, outputs: { files: [] } } }) as never,
          'p',
        ),
    ],
    [
      'cache.outputs',
      OUTPUTS,
      () =>
        validateProjectConfig(
          task({ cache: { inputs: { files: [] }, outputs: { files: [], ...X } } }) as never,
          'p',
        ),
    ],
    [
      'cacheRetention',
      RETENTION,
      () => validateWorkspace({ cacheRetention: { ...X } } as never, 'w'),
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
