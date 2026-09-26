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

// The page's workspace and its Run (item 700), imported the same way.
const PAGE = (await import(path.join(DOCS, 'src/playground/workspace.ts'))) as {
  ENV: Record<string, string>
  FILES: Record<string, string>
  TASKS: string[]
}
type RunOutcome =
  | { ok: true; tasks: PlanTask[]; cached: Set<string> }
  | { ok: false; errors: string[] }
interface DiffEntry {
  kind: string
  name: string
  change: string
  before: string | null
  after: string | null
}
type DiffKeyComponents = (
  before: readonly unknown[],
  after: readonly unknown[],
) => { entries: DiffEntry[]; unchangedCount: number }
const { diffRuns, runPlayground } = (await import(
  path.join(DOCS, 'src/components/demos/model/playground-view.ts')
)) as {
  runPlayground: (
    planner: unknown,
    input: {
      files: Record<string, string>
      env: Record<string, string>
      tasks: string[]
      cached: ReadonlySet<string>
    },
  ) => Promise<RunOutcome>
  diffRuns: (
    prev: readonly PlanTask[],
    next: readonly PlanTask[],
    diff: DiffKeyComponents,
  ) => Array<{ id: string; change: string; why: DiffEntry[] }>
}

// The labs (item 704): each lab's start state and the edits its steps make.
type LabEdit = { file: string; replace: string; with: string } | { file: string; append: string }
const LAB = (await import(path.join(DOCS, 'src/playground/labs.ts'))) as {
  LABS: Record<
    string,
    { files: Record<string, string>; env: Record<string, string>; tasks: string[] }
  >
  LAB_STEPS: Record<string, LabEdit[][]>
  applyEdits: (files: Record<string, string>, edits: readonly LabEdit[]) => Record<string, string>
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
/** The bundle's module: the page's Run calls it as its planner. */
let bundle: unknown

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

// The plan's fields `--dry=json` prints: the bundle's tasks also carry the
// key's components, which `vx why` answers for (item 703's rows).
const comparable = (tasks: PlanTask[]) =>
  tasks
    .map(({ id, project, task, hash, cacheStatus, deps }) => ({
      id,
      project,
      task,
      hash,
      cacheStatus,
      deps: [...deps].sort(),
    }))
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
let concurrent: BundlePlan[]
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
  bundle = await import(bundleFile)
  ;({ planPlayground, evaluateConfig } = bundle as {
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
  // Two plans in flight at once, as two playgrounds on one page start them
  // (item 704): the bundle holds one workspace at a time, so it queues them.
  arm()
  try {
    concurrent = await Promise.all(
      [SCENARIOS[0]!, SCENARIOS[1]!].map((sc) =>
        planPlayground({
          root: '/ws',
          files: { ...FILES, ...sc.edits },
          configs,
          env: sc.env,
          tasks: TASKS,
        }),
      ),
    )
  } finally {
    disarm()
  }

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

  it('two plans in flight at once: each plans what the CLI plans for its own files', () => {
    const cli = [SCENARIOS[0]!, SCENARIOS[1]!].map((sc) => comparable(outcomes.get(sc.name)!.cli))
    expect(
      movedFrom(outcomes.get(SCENARIOS[0]!.name)!.cli, outcomes.get(SCENARIOS[1]!.name)!.cli),
    ).toEqual(SCENARIOS[1]!.moved)
    expect(concurrent.map((p) => comparable(p.tasks))).toEqual(cli)
  })

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

// Item 835's sweep of the entry (packages/vx-docs/src/playground/entry.ts):
// what it adds to core's planner, one field at a time. The parity rows above
// held 12 of 21 mutations; these hold the rest that can happen.
describe("the bundle's entry, one field at a time (item 835)", () => {
  type Entry = {
    planPlayground: (input: Record<string, unknown>) => Promise<BundlePlan & { vfsReads: number }>
    listPlaygroundProjects: (input: {
      root: string
      files: Record<string, string>
    }) => Promise<Array<{ name: string; configFile: string | null }>>
  }
  const entry = () => bundle as Entry
  const plan = async (over: Record<string, unknown> = {}) =>
    entry().planPlayground({
      root: '/ws',
      files: FILES,
      configs: await evaluateAll(CONFIG_TEXTS),
      env: ENV,
      tasks: TASKS,
      ...over,
    })
  const refusal = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'resolved',
      (e: Error) => e.message,
    )

  it('a key the simulated cache holds is a hit; the others stay misses', async () => {
    const base = await plan()
    const utils = base.tasks.find((t) => t.id === '@pg/utils#build')!
    const again = await plan({ cached: [utils.hash] })
    const statuses = (p: BundlePlan) =>
      Object.fromEntries(p.tasks.map((t) => [t.id, t.cacheStatus]))
    const changed = Object.entries(statuses(again)).filter(([id, st]) => statuses(base)[id] !== st)
    expect(changed).toEqual([
      ['@pg/utils#build', again.tasks.find((t) => t.id === '@pg/utils#build')!.cacheStatus],
    ])
    expect(statuses(base)['@pg/utils#build']).not.toBe(changed[0]![1])
  })

  it('a package with no config file is planned around, not refused', async () => {
    const base = await plan()
    const withBare = await plan({
      files: { ...FILES, 'packages/bare/package.json': '{"name":"@pg/bare","version":"0.0.0"}' },
    })
    expect(withBare.tasks.map((t) => t.id).sort()).toEqual(base.tasks.map((t) => t.id).sort())
  })

  it('an invalid config is refused as the CLI refuses it; an unknown task is reported', async () => {
    const configs = await evaluateAll(CONFIG_TEXTS)
    const bad = { ...configs, '@pg/utils': { tasks: { build: { exec: { command: 1 } } } } }
    expect(await refusal(plan({ configs: bad }))).toContain('packages/utils/vx.config.mjs')
    const unknown = await plan({ tasks: ['no-such-task'] })
    expect(unknown.unresolvedTasks).toEqual(['no-such-task'])
    expect(unknown.vfsReads).toBeGreaterThan(0)
  })

  it('a project listing and a plan in flight together each see their own workspace', async () => {
    const solo = comparable((await plan()).tasks)
    const other = {
      root: '/other',
      files: {
        'package.json': '{"name":"other","private":true,"workspaces":["pkgs/*"]}',
        'pkgs/x/package.json': '{"name":"@o/x","version":"0.0.0"}',
        'pkgs/x/vx.config.mjs': 'export default {}\n',
      },
    }
    // Both calls start in the same tick: the listing must wait for the plan.
    const configs = await evaluateAll(CONFIG_TEXTS)
    const snapshot = JSON.stringify(configs)
    const [planned, listed] = await Promise.all([
      entry().planPlayground({ root: '/ws', files: FILES, configs, env: ENV, tasks: TASKS }),
      entry().listPlaygroundProjects(other),
    ])
    // And the caller's configs come back as they went in.
    expect(JSON.stringify(configs)).toBe(snapshot)
    expect(comparable(planned.tasks)).toEqual(solo)
    expect(listed).toEqual([{ name: '@o/x', configFile: 'pkgs/x/vx.config.mjs' }])
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
  // the page does. The page equals that path on what JSON drops; what JSON
  // cannot carry every path refuses (item 701, the row at the end).
  const WORKER_PATH_TEXTS: Record<string, string> = {
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

describe('a config is JSON data on the page as in the CLI (item 701)', () => {
  const FUNCTION_TEXT = `export default {
  tasks: { build: { exec: { command: 'true' }, description: () => 'built' } },
}
`

  it("a function-valued description: `vx run --dry=json`, the CLI's worker and the page give one refusal", async () => {
    const file = path.join(ws, CONFIG_FILE['@pg/docs']!)
    const refusal = (at: string): string =>
      `${at}: tasks.build.description is a function — a config must be JSON data, because the cache key folds its JSON`
    write({ ...FILES, [CONFIG_FILE['@pg/docs']!]: FUNCTION_TEXT })
    try {
      const cli = cliRun(ENV)
      const worker = await evaluateConfigFresh(file).then(
        () => 'RESOLVED',
        (e: unknown) => (e as Error).message,
      )
      const page = await evaluate(FUNCTION_TEXT)
      expect(cli.exitCode).toBe(1)
      expect(cli.stderr).toBe(`vx: ${refusal(file)}\n`)
      expect(worker).toBe(refusal(file))
      expect(page).toEqual({ ok: false, error: refusal('vx.config.mjs') })
    } finally {
      write(FILES)
    }
  })
})

describe("the playground page's workspace plans what the CLI plans (item 700)", () => {
  // The page's Run is the view module's `runPlayground`: core's discovery
  // (the bundle's `listPlaygroundProjects`) picks each config file, the
  // page evaluates its text, and the bundle plans. The CLI runs
  // `vx run build test --all --dry=json` over the same files, committed to
  // a repository of their own; the edit is uncommitted, as the fixture's is.
  const EDIT = 'packages/ui/src/button.tsx'
  const MOVED = ['app#build', 'app#test', 'ui#build', 'ui#test']
  const pageWs = path.join(scratch, 'page')
  const pageCache = path.join(scratch, 'page-cache')
  const runs = new Map<string, { cli: PlanTask[]; page: PlanTask[] }>()

  function pageWrite(files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(pageWs, rel)), { recursive: true })
      writeFileSync(path.join(pageWs, rel), body)
    }
  }

  function pageGit(...args: string[]): void {
    const r = Bun.spawnSync(['git', ...args], { cwd: pageWs, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  }

  function pageCli(): PlanTask[] {
    const r = Bun.spawnSync(
      [
        process.execPath,
        BIN,
        'run',
        ...PAGE.TASKS,
        '--all',
        '--dry=json',
        `--cache-dir=${pageCache}`,
      ],
      {
        cwd: pageWs,
        env: { ...baseEnv, ...PAGE.ENV, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    if (r.exitCode !== 0) throw new Error(`CLI exited ${r.exitCode}: ${r.stderr.toString()}`)
    return (JSON.parse(r.stdout.toString()) as { tasks: PlanTask[] }).tasks
  }

  async function pageRun(files: Record<string, string>): Promise<PlanTask[]> {
    arm()
    let r: RunOutcome
    try {
      r = await runPlayground(bundle, {
        files,
        env: PAGE.ENV,
        tasks: PAGE.TASKS,
        cached: new Set(),
      })
    } finally {
      disarm()
    }
    if (!r.ok) throw new Error(r.errors.join('\n'))
    return r.tasks
  }

  beforeAll(async () => {
    pageWrite(PAGE.FILES)
    pageGit('init', '-q')
    pageGit('add', '-A')
    pageGit(
      '-c',
      'user.email=parity@vx',
      '-c',
      'user.name=parity',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'page',
    )
    const edited = { ...PAGE.FILES, [EDIT]: `${PAGE.FILES[EDIT]}// edited\n` }
    for (const [name, files] of [
      ['committed', PAGE.FILES],
      ['edited', edited],
    ] as const) {
      pageWrite(files)
      runs.set(name, { cli: pageCli(), page: await pageRun(files) })
    }
  }, 60_000)

  for (const name of ['committed', 'edited']) {
    it(`${name}: every task's key, cache status and deps`, () => {
      const { cli, page } = runs.get(name)!
      expect(cli.length).toBe(8)
      expect(comparable(page)).toEqual(comparable(cli))
    })
  }

  it(`an edit to ${EDIT} moves exactly ${MOVED.join(', ')}, in both planners`, () => {
    const base = runs.get('committed')!
    const edit = runs.get('edited')!
    expect(movedFrom(base.cli, edit.cli)).toEqual(MOVED)
    expect(movedFrom(base.page, edit.page)).toEqual(MOVED)
  })
})

describe('the page names what moved a key as `vx why` does (item 703)', () => {
  // The CLI half RUNS here: `vx run build test --all` saves each miss and
  // records its key's components in `entry_inputs`, and `vx why` diffs them
  // with `diffKeyComponents`. The page's half is the view's `diffRuns` over
  // successive Runs of the bundle, with the bundle's copy of the same
  // function. The page's commands (`vite build`, `tsc -b`, …) are not on
  // this box, so both halves read the page's texts with every command made
  // `true`: a command folds into its task's key, and no step moves a config.
  // Three steps, one per verdict the join gives: the page's `button.tsx`
  // edit (changed), then a new file (added), then that file gone (removed).
  const EDIT = 'packages/ui/src/button.tsx'
  const NEW = 'packages/ui/src/icon.tsx'
  const MOVED = ['app#build', 'app#test', 'ui#build', 'ui#test']
  const whyWs = path.join(scratch, 'why')
  const whyCache = path.join(scratch, 'why-cache')
  const harmless = (files: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(files).map(([f, text]) => [
        f,
        f.endsWith('vx.config.mjs') ? text.replace(/command: '[^']*'/g, "command: 'true'") : text,
      ]),
    )
  const committed = harmless(PAGE.FILES)
  const edited = { ...committed, [EDIT]: `${committed[EDIT]}// edited\n` }
  const withNew = { ...edited, [NEW]: 'export const Icon = () => null\n' }
  const expected = (file: string, change: string): Record<string, string[][]> => ({
    'app#build': [['upstream', 'ui#build', 'changed']],
    'app#test': [['upstream', 'app#build', 'changed']],
    'ui#build': [['file', file, change]],
    'ui#test': [
      ['file', file, change],
      ['upstream', 'ui#build', 'changed'],
    ],
  })
  const STEPS = [
    { name: `${EDIT} edited`, files: edited, expected: expected(EDIT, 'changed') },
    { name: `${NEW} added`, files: withNew, expected: expected(NEW, 'added') },
    { name: `${NEW} removed`, files: edited, expected: expected(NEW, 'removed') },
  ]
  const cli = new Map<string, Map<string, DiffEntry[]>>()
  const page = new Map<string, Map<string, DiffEntry[]>>()

  function whyWrite(files: Record<string, string>): void {
    rmSync(path.join(whyWs, NEW), { force: true })
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(whyWs, rel)), { recursive: true })
      writeFileSync(path.join(whyWs, rel), body)
    }
  }

  function whyGit(...args: string[]): void {
    const r = Bun.spawnSync(['git', ...args], { cwd: whyWs, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  }

  function vx(...args: string[]): string {
    const r = Bun.spawnSync([process.execPath, BIN, ...args, `--cache-dir=${whyCache}`], {
      cwd: whyWs,
      env: { ...baseEnv, ...PAGE.ENV, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) {
      throw new Error(`vx ${args.join(' ')} exited ${r.exitCode}: ${r.stderr.toString()}`)
    }
    return r.stdout.toString()
  }

  async function pageRun(
    files: Record<string, string>,
    cached: ReadonlySet<string>,
  ): Promise<{ tasks: PlanTask[]; cached: Set<string> }> {
    arm()
    let r: RunOutcome
    try {
      r = await runPlayground(bundle, { files, env: PAGE.ENV, tasks: PAGE.TASKS, cached })
    } finally {
      disarm()
    }
    if (!r.ok) throw new Error(r.errors.join('\n'))
    return r
  }

  beforeAll(async () => {
    whyWrite(committed)
    whyGit('init', '-q')
    whyGit('add', '-A')
    whyGit(
      '-c',
      'user.email=parity@vx',
      '-c',
      'user.name=parity',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'why',
    )
    vx('run', ...PAGE.TASKS, '--all')
    const diff = (bundle as { diffKeyComponents: DiffKeyComponents }).diffKeyComponents
    let last = await pageRun(committed, new Set())
    for (const step of STEPS) {
      whyWrite(step.files)
      vx('run', ...PAGE.TASKS, '--all')
      const said = new Map<string, DiffEntry[]>()
      for (const id of MOVED) {
        const out = JSON.parse(vx('why', id, '--format', 'json')) as {
          diff: { entries: DiffEntry[] }
        }
        said.set(id, out.diff.entries)
      }
      cli.set(step.name, said)

      const next = await pageRun(step.files, last.cached)
      page.set(
        step.name,
        new Map(
          diffRuns(last.tasks, next.tasks, diff)
            .filter((r) => r.change === 'moved')
            .map((r) => [r.id, r.why]),
        ),
      )
      last = next
    }
  }, 60_000)

  const byText = (a: string[], b: string[]): number =>
    a.join('\0') < b.join('\0') ? -1 : a.join('\0') > b.join('\0') ? 1 : 0
  const named = (entries: readonly DiffEntry[]): string[][] =>
    entries.map((e) => [e.kind, e.name, e.change]).sort(byText)

  for (const step of STEPS) {
    it(`${step.name}: the page moves exactly ${MOVED.join(', ')}`, () => {
      expect([...page.get(step.name)!.keys()].sort()).toEqual(MOVED)
    })

    it(`${step.name}: \`vx why\`'s diff.entries are the page's named changes, for each`, () => {
      const said = cli.get(step.name)!
      const shown = page.get(step.name)!
      for (const id of MOVED) {
        expect({ id, cli: named(said.get(id)!) }).toEqual({ id, cli: step.expected[id]! })
        expect({ id, page: named(shown.get(id)!) }).toEqual({ id, page: step.expected[id]! })
        // The hashes too: a file's OIDs, an upstream's keys.
        expect({ id, page: shown.get(id) }).toEqual({ id, page: said.get(id) })
      }
    })
  }
})

describe('the labs plan what the CLI plans, before and after each fix (item 704)', () => {
  // Each lab's start state is committed to a repository of its own; each
  // step's edits are uncommitted on top of the step before, as the reader
  // makes them. Per state, `vx run <the lab's tasks> --all --dry=json` and
  // the page's Run with an empty cache must plan the same keys and statuses,
  // and each step must move the same keys in both planners: the hand-written
  // set below. Lab 3 opens on a graph core refuses, and the page must show
  // the CLI's words.
  const REFUSAL =
    'ui#build and ui#bundle both declare the output "dist/**" in cache.outputs.files — ' +
    "vx cleans a task's declared outputs before it runs and before a cache-hit restore, so " +
    "whichever of these runs second DELETES the other's output and the run still reports " +
    'success. Give each task its own output path.'
  const UI = ['app#build', 'app#test', 'ui#build', 'ui#test']
  const API = ['api#build', 'api#test', 'app#build', 'app#test']
  // Per state: how many tasks it plans, or the refusal; and what it moves
  // against the state before (null after a refused state, or for the first).
  const TRUTH: Record<string, Array<{ plans: number | string; moved: string[] | null }>> = {
    'unlisted-file': [
      { plans: 8, moved: null },
      { plans: 8, moved: [] },
      { plans: 8, moved: UI },
      { plans: 8, moved: UI },
    ],
    'undeclared-read': [
      { plans: 8, moved: null },
      { plans: 8, moved: [] },
      { plans: 8, moved: API },
      { plans: 8, moved: API },
      { plans: 8, moved: API },
    ],
    'shared-output': [
      { plans: REFUSAL, moved: null },
      { plans: 9, moved: null },
      { plans: 9, moved: [] },
      { plans: 9, moved: ['app#build', 'app#test', 'ui#build', 'ui#bundle', 'ui#test'] },
    ],
  }
  type Side = { ok: true; tasks: PlanTask[] } | { ok: false; error: string }
  const results = new Map<string, Array<{ cli: Side; page: Side }>>()

  function labWrite(dir: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), body)
    }
  }

  function labSpawn(
    dir: string,
    cmd: string[],
  ): { exitCode: number; stdout: string; stderr: string } {
    const r = Bun.spawnSync(cmd, {
      cwd: dir,
      env: { ...baseEnv, ...PAGE.ENV, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }

  function labGit(dir: string, ...args: string[]): void {
    const r = labSpawn(dir, ['git', ...args])
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }

  beforeAll(async () => {
    for (const [lab, start] of Object.entries(LAB.LABS)) {
      const dir = path.join(scratch, `lab-${lab}`)
      labWrite(dir, start.files)
      labGit(dir, 'init', '-q')
      labGit(dir, 'add', '-A')
      labGit(
        dir,
        '-c',
        'user.email=parity@vx',
        '-c',
        'user.name=parity',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        lab,
      )
      const states: Array<{ cli: Side; page: Side }> = []
      let files = start.files
      for (const edits of [[], ...LAB.LAB_STEPS[lab]!]) {
        files = LAB.applyEdits(files, edits)
        labWrite(dir, files)
        const cli = labSpawn(dir, [
          process.execPath,
          BIN,
          'run',
          ...start.tasks,
          '--all',
          '--dry=json',
          `--cache-dir=${path.join(scratch, `lab-${lab}-cache`)}`,
        ])
        arm()
        let page: RunOutcome
        try {
          page = await runPlayground(bundle, {
            files,
            env: start.env,
            tasks: start.tasks,
            cached: new Set(),
          })
        } finally {
          disarm()
        }
        states.push({
          cli:
            cli.exitCode === 0
              ? { ok: true, tasks: (JSON.parse(cli.stdout) as { tasks: PlanTask[] }).tasks }
              : { ok: false, error: cli.stderr },
          page: page.ok
            ? { ok: true, tasks: page.tasks }
            : { ok: false, error: page.errors.join('\n') },
        })
      }
      results.set(lab, states)
    }
  }, 60_000)

  for (const [lab, truth] of Object.entries(TRUTH)) {
    for (const [i, t] of truth.entries()) {
      const name = i === 0 ? `${lab}, as it opens` : `${lab}, after step ${i + 1}'s edits`
      const plans = t.plans
      if (typeof plans === 'string') {
        it(`${name}: the page shows the refusal the CLI prints`, () => {
          const { cli, page } = results.get(lab)![i]!
          expect(cli).toEqual({ ok: false, error: `vx: ${plans}\n` })
          expect(page).toEqual({ ok: false, error: plans })
        })
        continue
      }
      it(`${name}: every task's key, cache status and deps`, () => {
        const { cli, page } = results.get(lab)![i]!
        if (!cli.ok || !page.ok) throw new Error(`refused: ${JSON.stringify({ cli, page })}`)
        expect(cli.tasks.length).toBe(plans)
        expect(comparable(page.tasks)).toEqual(comparable(cli.tasks))
      })
      const moved = t.moved
      if (moved === null) continue
      it(`${name}: moves exactly ${moved.length} keys, in both planners`, () => {
        const before = results.get(lab)![i - 1]!
        const now = results.get(lab)![i]!
        const tasks = (s: Side): PlanTask[] => (s.ok ? s.tasks : [])
        expect(movedFrom(tasks(before.cli), tasks(now.cli))).toEqual(moved)
        expect(movedFrom(tasks(before.page), tasks(now.page))).toEqual(moved)
      })
    }
  }
})
