// Seeded property rows for the config schema (src/workspace/config-schema.ts).
// The contract and per-level suites probe one field at a time against a
// fixed seed; these draw whole configs, so a field is checked beside every
// sibling the generator can put next to it:
//
// - every generated valid config is accepted, left as it was, and accepted
//   again after a JSON round trip (the lock and the config worker hand it
//   back as JSON);
// - each single-field corruption (a wrong type, an unknown key, a value out
//   of the field's set) is refused by a UserError naming that field's path;
// - any value at any node yields acceptance or a UserError, never a
//   TypeError from the validator itself.
//
// A failure prints its seed and the path it corrupted.

import { describe, expect, it } from 'bun:test'
import type { ProjectConfig, WorkspaceConfig } from '../src/config.js'
import { validateProjectConfig, validateWorkspace } from '../src/workspace/config-schema.js'
import { MAX_TIMEOUT_MS, UserError } from '../src/util/index.js'
import { rng } from './helpers/rng.js'

const PROJECT_PATH = '/ws/pkg/vx.config.ts'
const WORKSPACE_PATH = '/ws/vx.workspace.ts'
const SEEDS = 300
/** Nodes each seed corrupts: every node of every seed cost 700 ms. */
const PER_SEED = 6

type R = () => number
type Obj = Record<string, unknown>
type Seg = string | number

const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const chance = (r: R, p = 0.5): boolean => r() < p
const some = <T>(r: R, xs: readonly T[], min = 0): T[] => {
  const out = xs.filter(() => chance(r))
  return out.length >= min ? out : xs.slice(0, min)
}
/** Sets each field whose draw is not undefined: an absent field is never written as one. */
const fields = (entries: Record<string, unknown>): Obj =>
  Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined))
const maybe = <T>(r: R, make: () => T, p = 0.5): T | undefined =>
  chance(r, p) ? make() : undefined

const TASK_NAMES = ['build', 'test', 'lint', 'dev', 'typecheck'] as const
const DEPS = ['^build', 'codegen', 'pkg-a#build'] as const

function genSandbox(r: R): Obj {
  return fields({
    allow: maybe(r, () =>
      fields({
        read: maybe(r, () => some(r, ['/opt/sdk', '~/.cache/**'], 1)),
        write: maybe(r, () => some(r, ['/tmp/out', 'coverage'], 1)),
        systemInfo: maybe(r, () => ['hw.ncpu']),
        machLookup: maybe(r, () => ['com.apple.trustd']),
        pty: maybe(r, () => chance(r)),
        gitConfig: maybe(r, () => chance(r)),
        network: maybe(r, () => (chance(r) ? true : ['registry.npmjs.org'])),
        unixSockets: maybe(r, () => (chance(r) ? true : ['/var/run/docker.sock'])),
        localBinding: maybe(r, () => (chance(r) ? chance(r) : some(r, [3000, 8080], 1))),
      }),
    ),
    deny: maybe(r, () => ({ network: ['example.com'] })),
    ignore: maybe(r, () =>
      fields({
        read: maybe(r, () => ['/proc/**']),
        write: maybe(r, () => ['/dev/tty']),
        systemInfo: maybe(r, () => ['kern.*']),
        network: maybe(r, () => ['*.local']),
      }),
    ),
    weakerWhenNested: maybe(r, () => chance(r)),
    weakerNetworkIsolation: maybe(r, () => chance(r)),
  })
}

function genEnv(r: R): Obj {
  return fields({
    passThrough: maybe(r, () => some(r, ['HOME', 'CI', 'TERM'])),
    define: maybe(r, () => fields({ NODE_ENV: 'production', DEBUG: maybe(r, () => '') })),
    secret: maybe(r, () => some(r, ['NPM_TOKEN', 'GH_TOKEN'])),
  })
}

function genCache(r: R, dependsOn: string[] | undefined): Obj {
  return {
    inputs: fields({
      files: pick(r, [
        ['src/**'],
        ['src/**', '!src/**/*.test.ts'],
        ['**/*.ts', 'tsconfig.json'],
        [],
      ]),
      env: maybe(r, () => some(r, ['NODE_ENV', 'API_URL'])),
      // A filter names a declared dependency or a wildcard (item 994).
      tasks: maybe(r, () => [...some(r, ['*', '^*']), ...some(r, dependsOn ?? [])]),
      runtime: maybe(r, () => ['node --version']),
      workspaceRuntime: maybe(r, () => ['bun --version']),
      workspaceFiles: maybe(r, () => some(r, ['tsconfig.base.json', 'patches/**'])),
    }),
    outputs: fields({
      files: pick(r, [['dist/**'], ['dist/**', '!dist/cache/**'], []]),
      workspaceFiles: maybe(r, () => ['reports/pkg/**']),
    }),
  }
}

function genTask(r: R): Obj {
  const description = maybe(r, () => pick(r, ['Builds the package', '']))
  if (chance(r, 0.15)) return fields({ dependsOn: some(r, DEPS), description })
  const dependsOn = maybe(r, () => some(r, DEPS))
  const mode = pick(r, ['plain', 'cached', 'persistent', 'interactive'] as const)
  const cache = mode === 'cached' ? genCache(r, dependsOn) : undefined
  const exec = fields({
    command: pick(r, ['bun test', 'tsc -b', 'echo "hi" && exit 0']),
    timeout: maybe(r, () => pick(r, [1, 60_000, MAX_TIMEOUT_MS])),
    retries: mode === 'persistent' ? undefined : maybe(r, () => pick(r, [0, 2])),
    remote: maybe(r, () => pick(r, mode === 'cached' ? [true, false, 'only'] : [true, false])),
    env: maybe(r, () => genEnv(r)),
    interactive: mode === 'interactive' ? true : maybe(r, () => false),
    persistent:
      mode === 'persistent'
        ? fields({ readyWhen: maybe(r, () => 'listening on \\d+') })
        : undefined,
    sandbox: mode === 'interactive' ? undefined : maybe(r, () => genSandbox(r)),
  })
  return fields({ description, exec, dependsOn, cache })
}

function genProject(r: R): Obj {
  return fields({
    tags: maybe(r, () => some(r, ['app', 'lib', 'team-a'])),
    tasks: maybe(r, () => Object.fromEntries(some(r, TASK_NAMES).map((n) => [n, genTask(r)])), 0.9),
  })
}

function genWorkspace(r: R): Obj {
  return fields({
    concurrency: maybe(r, () => pick(r, [1, 8])),
    cacheDir: maybe(r, () => pick(r, ['.vx-cache', ''])),
    timeout: maybe(r, () => pick(r, [1000, MAX_TIMEOUT_MS])),
    cacheRetention: maybe(r, () => {
      const olderThan = maybe(r, () => pick(r, ['30d', '12h', '90m']))
      const maxSize = maybe(r, () => pick(r, ['10G', '500MB']), olderThan === undefined ? 1 : 0.5)
      return fields({ olderThan, maxSize })
    }),
    affectedBase: maybe(r, () => pick(r, ['origin/main', 'HEAD~1'])),
    cacheScope: maybe(r, () => pick(r, ['trusted', 'read-only', 'pr-123', '@team/ci'])),
    rules: maybe(r, () =>
      fields({
        exclusiveOutputs: maybe(r, () => chance(r)),
        upfrontKeys: maybe(r, () => chance(r)),
      }),
    ),
  })
}

interface Node {
  path: Seg[]
  value: unknown
  /** A record keyed by user names (`tasks`, `define`): a new key is an entry, not an unknown field. */
  record: boolean
}

const RECORDS = new Set(['tasks', 'define'])

function nodes(value: unknown, path: Seg[] = [], out: Node[] = []): Node[] {
  out.push({ path, value, record: RECORDS.has(String(path.at(-1))) })
  if (Array.isArray(value)) value.forEach((v, i) => nodes(v, [...path, i], out))
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) nodes(v, [...path, k], out)
  }
  return out
}

function setAt(root: Obj, path: readonly Seg[], value: unknown): void {
  let at = root as Record<Seg, unknown>
  for (const seg of path.slice(0, -1)) at = at[seg] as Record<Seg, unknown>
  at[path.at(-1)!] = value
}

const clone = <T>(v: T): T => structuredClone(v)

/** The field a refusal must name: an array element is named by its array. */
const fieldPath = (path: readonly Seg[]): string[] => {
  const i = path.findIndex((s) => typeof s === 'number')
  return (i === -1 ? path : path.slice(0, i)).map(String)
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `a.b.c` as the messages spell it: `tasks.x.exec.timeout`, `` `cacheRetention.maxSize` ``, `` `rules`.upfrontKeys ``. */
const names = (field: readonly string[]): RegExp =>
  new RegExp(`(?<![\\w.])${field.map(escape).join('`?\\.`?')}(?![\\w.])`)

type Outcome = { ok: true } | { ok: false; error: unknown }
function outcome(validate: () => void): Outcome {
  try {
    validate()
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

/** A value of another type than `v`, which no field of `v`'s shape accepts. */
function wrongType(v: unknown): unknown {
  if (typeof v === 'string') return 42
  if (typeof v === 'number') return 'x'
  if (typeof v === 'boolean') return 'yes'
  return 7
}

/**
 * Values of the right type that each field refuses, by field name (an
 * element by its array's name).
 */
const BAD_VALUES: Record<string, readonly unknown[]> = {
  command: ['   ', 'a\0b'],
  timeout: [0, -5, 1.5, MAX_TIMEOUT_MS + 1],
  retries: [-1, 0.5],
  remote: ['sometimes', 'ONLY'],
  readyWhen: ['(unclosed'],
  concurrency: [0, 2.5],
  cacheDir: ['   '],
  olderThan: ['soon', '0d'],
  maxSize: ['big', '0G', '100'],
  affectedBase: ['-x', 'a b'],
  cacheScope: ['has space', '', 'x'.repeat(129)],
  localBinding: [0, 70_000],
  tags: [''],
  passThrough: ['A=B', 'my.var', 'VITE_*', '!HOME'],
  secret: ['A=B', 'TOKEN_*', '!X'],
  env: ['A*', 'A=B', ''],
  files: ['', '/abs/**', '../x', 'a\\b'],
  workspaceFiles: ['', '/abs/**', '../x'],
  runtime: ['  ', 'a\0b'],
  workspaceRuntime: ['  '],
}

/** Garbage for the never-a-TypeError row: every JSON and non-JSON shape. */
const GARBAGE: readonly (() => unknown)[] = [
  () => null,
  () => undefined,
  () => 0,
  () => -1,
  () => NaN,
  () => Infinity,
  () => '',
  () => ' ',
  () => '\0',
  () => 'x',
  () => true,
  () => [],
  () => [null],
  () => [[]],
  () => ['a', 1],
  () => ({}),
  () => ({ x: 1 }),
  () => Object.create(null) as unknown,
  () => () => 1,
  () => Symbol('s'),
  () => 10n,
  () => new Date(0),
  () => new Map(),
  // oxlint-disable-next-line no-sparse-arrays -- a hole is the shape under test
  () => [, 'a'],
]

interface Schema {
  name: string
  gen: (r: R) => Obj
  validate: (c: Obj) => void
  /** The `BAD_VALUES` fields this schema's generator writes. */
  badFields: readonly string[]
}

const SCHEMAS: Schema[] = [
  {
    name: 'project',
    gen: genProject,
    validate: (c) => validateProjectConfig(c as ProjectConfig, PROJECT_PATH),
    badFields: [
      'command',
      'timeout',
      'retries',
      'remote',
      'readyWhen',
      'localBinding',
      'tags',
      'passThrough',
      'secret',
      'env',
      'files',
      'workspaceFiles',
      'runtime',
      'workspaceRuntime',
    ],
  },
  {
    name: 'workspace',
    gen: genWorkspace,
    validate: (c) => validateWorkspace(c as WorkspaceConfig, WORKSPACE_PATH),
    badFields: [
      'concurrency',
      'cacheDir',
      'timeout',
      'olderThan',
      'maxSize',
      'affectedBase',
      'cacheScope',
    ],
  },
]

const describeError = (e: unknown): string =>
  e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)

for (const schema of SCHEMAS) {
  describe(`${schema.name} config schema, seeded`, () => {
    it('accepts every generated valid config, unchanged, and again after JSON', () => {
      const failures: string[] = []
      for (let seed = 1; seed <= SEEDS; seed++) {
        const config = schema.gen(rng(seed))
        const before = clone(config)
        const first = outcome(() => schema.validate(config))
        if (!first.ok) failures.push(`seed ${seed}: refused: ${describeError(first.error)}`)
        else if (!Bun.deepEquals(config, before, true)) failures.push(`seed ${seed}: mutated`)
        const json = JSON.parse(JSON.stringify(config)) as Obj
        if (!Bun.deepEquals(json, before, true)) failures.push(`seed ${seed}: lost a field in JSON`)
        const again = outcome(() => schema.validate(json))
        if (!again.ok)
          failures.push(`seed ${seed}: refused after JSON: ${describeError(again.error)}`)
      }
      expect(failures).toEqual([])
    })

    it('refuses each single-field corruption, naming the field', () => {
      const failures: string[] = []
      // What the seeds drove to a named refusal, as `kind:field`: the
      // sample must reach every bad value the generator can host.
      const driven = new Set<string>()
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed)
        const base = schema.gen(r)
        const check = (
          kind: 'wrong type' | 'unknown key' | 'bad value',
          path: Seg[],
          mutate: (c: Obj) => void,
          extra?: string,
        ) => {
          const config = clone(base)
          mutate(config)
          const result = outcome(() => schema.validate(config))
          const at = `seed ${seed} ${kind} at ${path.join('.') || '<root>'}`
          if (result.ok) return failures.push(`${at}: accepted`)
          if (!(result.error instanceof UserError)) {
            return failures.push(`${at}: threw ${describeError(result.error)}`)
          }
          const field = fieldPath(path)
          const message = result.error.message
          if (field.length > 0 && !names(field).test(message)) {
            failures.push(`${at}: message does not name ${field.join('.')}: ${message}`)
          } else if (extra !== undefined && !message.includes(extra)) {
            failures.push(`${at}: message lacks ${extra}: ${message}`)
          } else driven.add(`${kind}:${field.at(-1) ?? ''}`)
          return undefined
        }
        const all = nodes(base)
        for (let i = 0; i < PER_SEED; i++) {
          const node = pick(r, all)
          const { path, value } = node
          if (path.length > 0) check('wrong type', path, (c) => setAt(c, path, wrongType(value)))
          const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
          if (isObject && !node.record) {
            const key = `zq${Math.floor(r() * 1e6)}`
            check(
              'unknown key',
              path,
              (c) => setAt(c, [...path, key], 1),
              `has unknown field "${key}"`,
            )
          }
          const name = String(path.findLast((s) => typeof s === 'string'))
          const bad = BAD_VALUES[name]
          if (bad !== undefined && path.length > 0 && typeof value !== 'object') {
            const v = pick(r, bad)
            check('bad value', path, (c) => setAt(c, path, v), undefined)
          }
        }
      }
      expect(failures).toEqual([])
      const kinds = (kind: string): string[] =>
        [...driven].filter((d) => d.startsWith(`${kind}:`)).map((d) => d.slice(kind.length + 1))
      expect(kinds('bad value').sort()).toEqual([...schema.badFields].sort())
      expect(kinds('wrong type').length).toBeGreaterThanOrEqual(schema.badFields.length)
      expect(kinds('unknown key').length).toBeGreaterThanOrEqual(3)
    })

    it('throws nothing but a UserError for any value at any node', () => {
      const failures: string[] = []
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed)
        const base = schema.gen(r)
        const all = nodes(base).filter((n) => n.path.length > 0)
        for (let i = 0; i < 4 && all.length > 0; i++) {
          const { path } = pick(r, all)
          const value = pick(r, GARBAGE)()
          const config = clone(base)
          setAt(config, path, value)
          const result = outcome(() => schema.validate(config))
          if (!result.ok && !(result.error instanceof UserError)) {
            failures.push(
              `seed ${seed} at ${path.join('.')} = ${Bun.inspect(value)}: ${describeError(result.error)}`,
            )
          }
        }
      }
      expect(failures).toEqual([])
    })
  })
}
