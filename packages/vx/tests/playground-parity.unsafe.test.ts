// The site's playground plans exactly what the CLI plans (roadmap W9, item
// 695; design: docs/design/playground-spike-2026-09.md § W9 decisions).
//
// The playground is core's own planner source, bundled for the browser
// behind a shim (packages/vx-docs/src/playground/). These rows build that
// bundle with the site's own `buildPlayground()`, the function
// `@vzn/vx-docs#build.playground` runs, so the bytes under test are the
// bytes the site ships (`@vzn/vx-docs`'s playground-bundle row holds the
// shipped copy to the same function). Then, per scenario:
//   CLI    — `vx run build ci --all --dry=json` in a subprocess over the
//            fixture committed to a fresh git repository: the real planner,
//            real git, real disk, real Bun;
//   bundle — `planPlayground` over the same files held in memory, each
//            config the bundle's `evaluateConfig` of the same
//            `vx.config.mjs` text (item 699), with the host's Bun APIs and
//            `node:fs` TRAPPED (each replaced by a function that counts and
//            throws) for the whole call, so a reach past the shim fails
//            loudly instead of quietly agreeing.
// Keys, cache statuses and deps must be equal, and so must the bundled
// scheduler's priorities and dispatch order against core's scheduler run
// on the CLI's graph. Unsafe: the CLI half needs git, and the rows read
// another package.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { computeReverseDepCount } from '../src/graph/priorities.js'
import { runGraph } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/index.js'
import { evaluateConfigFresh } from '../src/workspace/config-eval.js'

const REPO = path.resolve(import.meta.dir, '../../..')
const DOCS = path.join(REPO, 'packages/vx-docs')
const BIN = path.join(REPO, 'packages/vx/src/bin.ts')

interface PlanTask {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: string
  deps: string[]
}

interface BundlePlan {
  tasks: PlanTask[]
  priorities: Record<string, number>
  dispatchOrder: string[]
  platformCalls: Record<string, number>
  unresolvedTasks: string[]
}

type PlanPlayground = (input: {
  root: string
  files: Record<string, string>
  configs: Record<string, unknown>
  env: Record<string, string>
  tasks: string[]
}) => Promise<BundlePlan>

type Evaluated = { ok: true; config: unknown } | { ok: false; error: string }
type EvaluateConfig = (text: string, deadlineMs: number) => Promise<Evaluated>

// Imported by path, not by specifier: core's type-check and its lint key
// stay its own, and the site's files are this suite's inputs through
// `test.bun.unsafe`'s `packages/*/**`.
const { buildPlayground } = (await import(path.join(DOCS, 'scripts/build-playground.ts'))) as {
  buildPlayground: () => Promise<{ bytes: Uint8Array }>
}
const { CONFIG_TEXTS, ENV, FILES } = (await import(
  path.join(DOCS, 'src/playground/fixture.ts')
)) as {
  CONFIG_TEXTS: Record<string, string>
  ENV: Record<string, string>
  FILES: Record<string, string>
}
const { NOT_AN_OBJECT } = (await import(path.join(DOCS, 'src/playground/config-eval.ts'))) as {
  NOT_AN_OBJECT: string
}

const ONLY_VX = 'the playground evaluates a config on its own: it can import only @vzn/vx'
const CONFIG_FILE: Record<string, string> = {
  '@pg/utils': 'packages/utils/vx.config.mjs',
  '@pg/core': 'packages/core/vx.config.mjs',
  '@pg/ui': 'packages/ui/vx.config.mjs',
  '@pg/app': 'packages/app/vx.config.mjs',
  '@pg/docs': 'packages/docs/vx.config.mjs',
}

// `ci` is a group task (no exec): its key is `computeGroupHash` over its deps.
const TASKS = ['build', 'ci']
const API_TASKS = ['@pg/app#build', '@pg/app#ci', '@pg/core#build', '@pg/core#test', '@pg/ui#build']

const SCENARIOS: Array<{
  name: string
  env: Record<string, string>
  edits: Record<string, string>
  moved: string[]
}> = [
  { name: 'the committed tree', env: ENV, edits: {}, moved: [] },
  {
    name: 'an env change (API_URL)',
    env: { API_URL: 'https://staging.example.test' },
    edits: {},
    moved: API_TASKS,
  },
  {
    // The CLI hashes the dirty file from disk; the bundle computes its blob
    // OID from memory. The two must agree.
    name: 'an uncommitted edit in @pg/utils',
    env: ENV,
    edits: { 'packages/utils/src/strings.ts': 'export const shout = (s: string) => `${s}!`\n' },
    moved: [...API_TASKS, '@pg/utils#build'],
  },
]

// `@pg/core`'s config, written three other ways. Each text is the file on
// disk for the CLI and the text the page evaluates; `moved` is what it moves
// against the fixture's own text, in both planners.
const CORE_TEST_DOWNSTREAM = ['@pg/app#build', '@pg/app#ci', '@pg/core#test']
const CORE_VARIANTS: Array<{ name: string; text: string; moved: string[] }> = [
  {
    // Computed, and equal to the literal: it moves nothing.
    name: 'a config computed with a loop and spreads',
    text: `import { defineProject } from '@vzn/vx'

const SOURCES = ['src/**']
const inputs = {}
for (const [task, extra] of [['build', 'package.json'], ['test', 'test/**']]) {
  inputs[task] = { files: [...SOURCES, extra] }
}

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/*.ts dist/' },
      cache: { inputs: { ...inputs.build, env: ['API_URL'] }, outputs: { files: ['dist'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      cache: { inputs: inputs.test, outputs: { files: [] } },
    },
  },
})
`,
    moved: [],
  },
  {
    // JSON drops an \`undefined\` property, and so does the key.
    name: 'properties whose value is undefined',
    text: `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      description: undefined,
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/*.ts dist/', timeout: undefined },
      cache: {
        inputs: { files: ['src/**', 'package.json'], env: ['API_URL'], workspaceFiles: undefined },
        outputs: { files: ['dist'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**', 'test/**'] }, outputs: { files: [] } },
    },
  },
})
`,
    moved: [],
  },
  {
    // \`test\` now also waits on the upstream builds.
    name: 'dependsOn built from a constant',
    text: `import { defineProject } from '@vzn/vx'

const UPSTREAM = ['^build']

export default defineProject({
  tasks: {
    build: {
      dependsOn: UPSTREAM,
      exec: { command: 'mkdir -p dist && cp src/*.ts dist/' },
      cache: {
        inputs: { files: ['src/**', 'package.json'], env: ['API_URL'] },
        outputs: { files: ['dist'] },
      },
    },
    test: {
      dependsOn: [...UPSTREAM, 'build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**', 'test/**'] }, outputs: { files: [] } },
    },
  },
})
`,
    moved: CORE_TEST_DOWNSTREAM,
  },
]

// The negative control's variant: one folded field (`@pg/core#test`'s
// command) differs from the text the page evaluates.
const CONTROL_TEXT = CONFIG_TEXTS['@pg/core']!.replace("command: 'true'", "command: 'exit 0'")

// A root through no symlink (macOS's temp dir is one), so neither planner
// sees a path the other would canonicalize.
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-pg-')))
const ws = path.join(scratch, 'ws')
const cacheDir = path.join(scratch, 'cache')

function write(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true })
    writeFileSync(path.join(ws, rel), body)
  }
}

function git(...args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd: ws, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

const baseEnv = { ...process.env }
delete baseEnv['API_URL']

function cliRun(env: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(
    [process.execPath, BIN, 'run', ...TASKS, '--all', '--dry=json', `--cache-dir=${cacheDir}`],
    { cwd: ws, env: { ...baseEnv, ...env, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' },
  )
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function cliPlan(env: Record<string, string>): PlanTask[] {
  const r = cliRun(env)
  if (r.exitCode !== 0) throw new Error(`CLI exited ${r.exitCode}: ${r.stderr}`)
  return (JSON.parse(r.stdout) as { tasks: PlanTask[] }).tasks
}

// ---- traps: the host's platform, made to throw while the bundle runs ----
const trapHits: Record<string, number> = {}
const notTrappable: string[] = []
const restores: Array<() => void> = []
function trap(obj: Record<string, unknown>, key: string, label: string): void {
  const orig = obj[key]
  const fn = (): never => {
    trapHits[label] = (trapHits[label] ?? 0) + 1
    throw new Error(`trapped: the bundle reached the host's ${label}`)
  }
  try {
    obj[key] = fn
  } catch {
    // a read-only property: recorded below
  }
  if (obj[key] !== fn) {
    notTrappable.push(label)
    return
  }
  restores.push(() => {
    obj[key] = orig
  })
}
function arm(): void {
  trap(Bun.hash as unknown as Record<string, unknown>, 'xxHash3', 'Bun.hash.xxHash3')
  for (const k of ['Glob', 'file', 'spawn', 'spawnSync', 'CryptoHasher', 'nanoseconds', 'write']) {
    trap(Bun as unknown as Record<string, unknown>, k, `Bun.${k}`)
  }
  for (const k of [
    'readFileSync',
    'lstatSync',
    'statSync',
    'existsSync',
    'readdirSync',
    'readlinkSync',
    'realpathSync',
  ]) {
    trap(fs as unknown as Record<string, unknown>, k, `node:fs ${k}`)
  }
  for (const k of ['readFile', 'readdir', 'stat', 'lstat', 'realpath']) {
    trap(fsp as unknown as Record<string, unknown>, k, `node:fs/promises ${k}`)
  }
}
function disarm(): void {
  while (restores.length > 0) restores.pop()!()
}

let planPlayground: PlanPlayground
let evaluateConfig: EvaluateConfig

async function evaluate(text: string, deadlineMs = 10_000): Promise<Evaluated> {
  arm()
  try {
    return await evaluateConfig(text, deadlineMs)
  } finally {
    disarm()
  }
}

/** Each project's config, evaluated by the page from its text. */
async function evaluateAll(texts: Record<string, string>): Promise<Record<string, unknown>> {
  const configs: Record<string, unknown> = {}
  for (const [name, text] of Object.entries(texts)) {
    const r = await evaluate(text)
    if (!r.ok) throw new Error(`${name}: ${r.error}`)
    configs[name] = r.config
  }
  return configs
}

async function bundlePlan(
  files: Record<string, string>,
  env: Record<string, string>,
  configs: Record<string, unknown>,
): Promise<BundlePlan> {
  arm()
  try {
    return await planPlayground({ root: '/ws', files, configs, env, tasks: TASKS })
  } finally {
    disarm()
  }
}

async function nativeSchedule(
  tasks: PlanTask[],
): Promise<{ priorities: Record<string, number>; dispatchOrder: string[] }> {
  const nodes = new Map<string, TaskNode>()
  for (const t of tasks) {
    nodes.set(t.id, {
      id: t.id,
      projectName: t.project,
      projectDir: `/${t.project}`,
      taskName: t.task,
      config: {} as TaskNode['config'],
      deps: t.deps,
      requested: true,
    })
  }
  const priorities = computeReverseDepCount(nodes)
  const dispatchOrder: string[] = []
  await runGraph({
    nodes,
    // The bundle's `runGraph` runs with the entry's default of 2 workers.
    concurrency: 2,
    priorities,
    execute: async (node) => {
      dispatchOrder.push(node.id)
      return { node, status: 'success', exitCode: 0, durationMs: 0 }
    },
  })
  return { priorities: Object.fromEntries(priorities), dispatchOrder }
}

const comparable = (tasks: PlanTask[]) =>
  tasks
    .map((t) => ({ ...t, deps: [...t.deps].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const movedFrom = (base: PlanTask[], tasks: PlanTask[]): string[] =>
  tasks
    .filter((t) => base.find((b) => b.id === t.id)?.hash !== t.hash)
    .map((t) => t.id)
    .sort()

interface Outcome {
  cli: PlanTask[]
  bundle: BundlePlan
  native: { priorities: Record<string, number>; dispatchOrder: string[] }
}
const outcomes = new Map<string, Outcome>()
let wrongEnv: BundlePlan
let bundleTrapHits: Record<string, number>
const variants = new Map<string, { cli: PlanTask[]; bundle: BundlePlan }>()
let control: { cli: PlanTask[]; bundle: BundlePlan }
const NOT_OBJECT_TEXTS: Record<string, string> = {
  'a number': 'export default 42\n',
  'no default export':
    "import { defineProject } from '@vzn/vx'\nexport const config = defineProject({})\n",
}
const notObject = new Map<string, { cli: ReturnType<typeof cliRun>; page: Evaluated }>()

beforeAll(async () => {
  const bundleFile = path.join(scratch, 'planner.js')
  writeFileSync(bundleFile, (await buildPlayground()).bytes)
  // Loaded BEFORE any trap is armed: loading reads the file through the host.
  ;({ planPlayground, evaluateConfig } = (await import(bundleFile)) as {
    planPlayground: PlanPlayground
    evaluateConfig: EvaluateConfig
  })
  const configs = await evaluateAll(CONFIG_TEXTS)

  write(FILES)
  git('init', '-q')
  git('add', '-A')
  git(
    '-c',
    'user.email=parity@vx',
    '-c',
    'user.name=parity',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  )
  for (const sc of SCENARIOS) {
    write({ ...FILES, ...sc.edits })
    const cli = cliPlan(sc.env)
    const bundle = await bundlePlan({ ...FILES, ...sc.edits }, sc.env, configs)
    outcomes.set(sc.name, { cli, bundle, native: await nativeSchedule(cli) })
  }
  wrongEnv = await bundlePlan(FILES, { API_URL: 'https://wrong.example.test' }, configs)

  for (const v of CORE_VARIANTS) {
    const files = { ...FILES, [CONFIG_FILE['@pg/core']!]: v.text }
    write(files)
    const cli = cliPlan(ENV)
    const bundle = await bundlePlan(
      files,
      ENV,
      await evaluateAll({ ...CONFIG_TEXTS, '@pg/core': v.text }),
    )
    variants.set(v.name, { cli, bundle })
  }

  // Both planners read the same files; only the page's config is evaluated
  // from the fixture's own text.
  const controlFiles = { ...FILES, [CONFIG_FILE['@pg/core']!]: CONTROL_TEXT }
  write(controlFiles)
  control = { cli: cliPlan(ENV), bundle: await bundlePlan(controlFiles, ENV, configs) }

  for (const [name, text] of Object.entries(NOT_OBJECT_TEXTS)) {
    write({ ...FILES, [CONFIG_FILE['@pg/docs']!]: text })
    notObject.set(name, { cli: cliRun(ENV), page: await evaluate(text) })
  }
  write(FILES)
  bundleTrapHits = { ...trapHits }
}, 60_000)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('the playground bundle plans what the CLI plans', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: every task's key, cache status and deps`, () => {
      const { cli, bundle } = outcomes.get(sc.name)!
      expect(cli.length).toBe(8)
      expect(bundle.unresolvedTasks).toEqual([])
      expect(comparable(bundle.tasks)).toEqual(comparable(cli))
    })

    it(`${sc.name}: the scheduler's priorities and dispatch order`, () => {
      const { bundle, native } = outcomes.get(sc.name)!
      expect(bundle.priorities).toEqual(native.priorities)
      expect(bundle.dispatchOrder).toEqual(native.dispatchOrder)
    })

    // Equal plans prove nothing if the scenario moved no key: each one
    // must move exactly the tasks it reaches, in both planners alike.
    it(`${sc.name}: moves exactly ${sc.moved.length} keys, in both planners`, () => {
      const base = outcomes.get(SCENARIOS[0]!.name)!
      const { cli, bundle } = outcomes.get(sc.name)!
      expect(movedFrom(base.cli, cli)).toEqual(sc.moved)
      expect(movedFrom(base.bundle.tasks, bundle.tasks)).toEqual(sc.moved)
    })
  }

  it('negative control: the bundle under the wrong API_URL differs from the CLI on exactly the tasks it reaches', () => {
    const base = outcomes.get(SCENARIOS[0]!.name)!
    expect(movedFrom(base.cli, wrongEnv.tasks)).toEqual(API_TASKS)
  })

  it("never reaches the host's platform, and calls only the shim's hash, glob and file", () => {
    expect({ bundleTrapHits, notTrappable }).toEqual({ bundleTrapHits: {}, notTrappable: [] })
    const called = new Set<string>()
    for (const { bundle } of outcomes.values()) {
      for (const k of Object.keys(bundle.platformCalls)) called.add(k)
    }
    expect([...called].sort()).toEqual(['Bun.Glob', 'Bun.file', 'Bun.hash.xxHash3'])
  })

  it('the traps fire: a host call made while armed throws and is counted', () => {
    arm()
    try {
      expect(() => Bun.hash.xxHash3('x')).toThrow(
        "trapped: the bundle reached the host's Bun.hash.xxHash3",
      )
      expect(() => fs.existsSync(ws)).toThrow(
        "trapped: the bundle reached the host's node:fs existsSync",
      )
    } finally {
      disarm()
    }
    expect(trapHits['Bun.hash.xxHash3']).toBe(1)
    expect(fs.existsSync(ws)).toBe(true)
  })
})

describe("the page evaluates a config's text as the CLI does (item 699)", () => {
  for (const v of CORE_VARIANTS) {
    it(`${v.name}: every task's key, cache status and deps`, () => {
      const { cli, bundle } = variants.get(v.name)!
      expect(cli.length).toBe(8)
      expect(comparable(bundle.tasks)).toEqual(comparable(cli))
    })

    it(`${v.name}: moves exactly ${v.moved.length} keys, in both planners`, () => {
      const base = outcomes.get(SCENARIOS[0]!.name)!
      const { cli, bundle } = variants.get(v.name)!
      expect(movedFrom(base.cli, cli)).toEqual(v.moved)
      expect(movedFrom(base.bundle.tasks, bundle.tasks)).toEqual(v.moved)
    })
  }

  it("negative control: the page's config against the CLI's one-field variant differs on exactly the tasks it reaches", () => {
    expect(movedFrom(control.cli, control.bundle.tasks)).toEqual(CORE_TEST_DOWNSTREAM)
  })

  for (const name of Object.keys(NOT_OBJECT_TEXTS)) {
    it(`a default export that is not an object (${name}): the CLI's message, with the page's file name`, () => {
      const { cli, page } = notObject.get(name)!
      const file = path.join(ws, CONFIG_FILE['@pg/docs']!)
      expect(cli.exitCode).toBe(1)
      expect(cli.stderr).toBe(`vx: Project config at ${file} did not export a default object\n`)
      expect(page).toEqual({ ok: false, error: NOT_AN_OBJECT })
      expect(cli.stderr.replace(file, 'vx.config.mjs')).toBe(`vx: ${NOT_AN_OBJECT}\n`)
    })
  }

  // `vx run` evaluates a config in-process; a repeat load (`vx watch`)
  // evaluates it in a worker and JSON-round-trips it BEFORE validation, as
  // the page does. The page equals that path on what JSON drops.
  const WORKER_PATH_TEXTS: Record<string, string> = {
    'a function-valued property': `export default {
  tasks: { build: { exec: { command: 'true' }, description: () => 'built' } },
}
`,
    'an undefined property': `export default {
  tasks: { build: { exec: { command: 'true', timeout: undefined } } },
}
`,
  }
  for (const [name, text] of Object.entries(WORKER_PATH_TEXTS)) {
    it(`${name}: the page's object is the CLI worker's`, async () => {
      const file = path.join(scratch, `${name.replaceAll(' ', '-')}.mjs`)
      writeFileSync(file, text)
      const page = await evaluate(text)
      // Strict: a property kept with the value `undefined` is not a dropped one.
      expect(page).toStrictEqual({
        ok: true,
        config: { tasks: { build: { exec: { command: 'true' } } } },
      })
      expect(page).toStrictEqual({ ok: true, config: await evaluateConfigFresh(file) })
    })
  }

  it('an import of node:fs is refused by name', async () => {
    expect(await evaluate("import { readFileSync } from 'node:fs'\nexport default {}\n")).toEqual({
      ok: false,
      error: `cannot import 'node:fs': ${ONLY_VX}`,
    })
  })

  it('an import of a relative file is refused by name', async () => {
    expect(
      await evaluate(
        "import { defineProject } from '@vzn/vx'\nimport preset from './preset.mjs'\nexport default defineProject(preset)\n",
      ),
    ).toEqual({ ok: false, error: `cannot import './preset.mjs': ${ONLY_VX}` })
  })

  it('a config that never finishes is terminated at the deadline', async () => {
    expect(await evaluate('while (true) {}\nexport default {}\n', 200)).toEqual({
      ok: false,
      error: 'the config did not finish evaluating within 200 ms',
    })
  })
})
