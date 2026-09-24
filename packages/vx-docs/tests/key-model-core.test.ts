// The key calculator on learn/caching runs a MODEL of vx's key fold
// (demos/model/toy-monorepo.ts), because the real planner does not run in a
// browser yet (roadmap W9). The page may call it a model; it may not be
// wrong. So this runs real vx over the same toy workspace and holds the model
// to what vx does, step by step: which task keys move, which tasks hit, and
// which outputs are stale.
//
// The workspace is written FROM the model: each file holds `valueOf(state,
// input)`, each task's command reads exactly `readsOf(task)` and the outputs
// of the tasks it depends on, and each config declares `declaredBy(state,
// task)`. What is compared is what the model PREDICTS from that: the keys,
// the hits and the staleness. A stale output is one whose bytes differ from
// what the same state produces with the cache off, in a second workspace.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { isCacheHit, run, type Logger } from '@vzn/vx'
import {
  TOY_ENV,
  TOY_INPUTS,
  TOY_PACKAGES,
  TOY_SCENARIOS,
  TOY_START,
  TOY_TASKS,
  applyChange,
  declaredBy,
  readsOf,
  toyRun,
  valueOf,
  type ToyChange,
  type ToyRun,
  type ToyState,
} from '../src/components/demos/model/toy-monorepo.js'

const SILENT: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}
const NO_CACHE = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
const OUTPUT = { build: 'dist/out.txt', test: 'report.txt' } as const
const taskOf = new Map(TOY_TASKS.map((t) => [t.id, t]))
const roots: string[] = []

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'user.email=toy@vx.local',
      '-c',
      'user.name=toy',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

/** A task's config as vx reads it: the two rules W1 teaches, a command that
 *  reads what the model says it reads, and the inputs the state declares. */
function taskConfig(state: ToyState, id: string): Record<string, unknown> {
  const t = taskOf.get(id)!
  const local = (input: string): string => input.slice(t.pkg.length + 1)
  const files = readsOf(id)
    .filter((i) => i !== TOY_ENV)
    .map(local)
  const upstream = t.dependsOn.map((d) => {
    const dep = taskOf.get(d)!
    return dep.pkg === t.pkg ? OUTPUT[dep.name] : `../${dep.pkg}/${OUTPUT[dep.name]}`
  })
  const out = OUTPUT[t.name]
  const readsEnv = readsOf(id).includes(TOY_ENV)
  const declared = declaredBy(state, id)
  const command = [
    `mkdir -p ${path.dirname(out)}`,
    `cat ${[...files, ...upstream].join(' ')} > ${out}`,
    ...(readsEnv ? [`printf '%s\\n' "$${TOY_ENV}" >> ${out}`] : []),
  ].join(' && ')
  return {
    dependsOn: t.name === 'build' ? ['^build'] : ['build'],
    exec: { command, ...(readsEnv ? { env: { passThrough: [TOY_ENV] } } : {}) },
    cache: {
      inputs: {
        files: declared.filter((i) => i !== TOY_ENV).map(local),
        ...(declared.includes(TOY_ENV) ? { env: [TOY_ENV] } : {}),
      },
      outputs: { files: [out] },
    },
  }
}

async function writeToy(root: string, state: ToyState): Promise<void> {
  for (const p of TOY_PACKAGES) {
    const dir = path.join(root, 'packages', p.id)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    const deps = Object.fromEntries(p.dependsOn.map((d) => [d, 'workspace:*']))
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: p.id, version: '0.0.0', dependencies: deps }),
    )
    const tasks = Object.fromEntries(
      TOY_TASKS.filter((t) => t.pkg === p.id).map((t) => [t.name, taskConfig(state, t.id)]),
    )
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default ${JSON.stringify({ tasks })}\n`,
    )
    for (const input of TOY_INPUTS.filter((i) => i.startsWith(`${p.id}/`))) {
      await writeFile(path.join(root, 'packages', input), `${valueOf(state, input)}\n`)
    }
  }
}

async function makeToy(state: ToyState): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-key-model-'))
  roots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'toy', private: true }))
  await writeToy(root, state)
  // Committed, so the first keys fold git's blob ids for tracked, clean
  // files, and an edit takes the path a dirty file takes.
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'toy')
  return root
}

interface Observed {
  key: Record<string, string>
  hit: string[]
  outputs: Record<string, string>
  deps: Record<string, string[]>
}

async function vx(root: string, cached: boolean): Promise<Observed> {
  const r = await run({
    cwd: root,
    tasks: ['build', 'test'],
    log: SILENT,
    ...(cached ? {} : { cache: NO_CACHE }),
  })
  expect(r.ok).toBe(true)
  const byTask = new Map(r.outcomes.map((o) => [o.node.id, o]))
  const key: Record<string, string> = {}
  const outputs: Record<string, string> = {}
  const deps: Record<string, string[]> = {}
  for (const t of TOY_TASKS) {
    const o = byTask.get(t.id)!
    key[t.id] = o.hash!
    deps[t.id] = [...o.node.deps].sort()
    outputs[t.id] = await readFile(path.join(root, 'packages', t.pkg, OUTPUT[t.name]), 'utf8')
  }
  const hit = TOY_TASKS.filter((t) => isCacheHit(byTask.get(t.id)!.status)).map((t) => t.id)
  return { key, hit, outputs, deps }
}

// Every control the calculator offers, at least once, and the paths between
// them that the page teaches: a cascade, an undo that hits an old entry, the
// stale hit, a miss built on a stale upstream, the heal, and an env var
// passed through but not declared.
const STEPS: ToyChange[] = [
  { kind: 'edit', input: 'utils/src/index.ts' },
  { kind: 'edit', input: 'utils/src/index.ts' },
  { kind: 'edit', input: 'app/src/index.ts' },
  { kind: 'edit', input: TOY_ENV },
  { kind: 'edit', input: 'api/tsconfig.json' },
  { kind: 'declare', input: 'utils/tsconfig.json' },
  { kind: 'edit', input: 'utils/tsconfig.json' },
  { kind: 'edit', input: 'ui/src/index.ts' },
  { kind: 'declare', input: 'utils/tsconfig.json' },
  { kind: 'declare', input: TOY_ENV },
  { kind: 'edit', input: TOY_ENV },
  { kind: 'declare', input: 'ui/tsconfig.json' },
  { kind: 'edit', input: 'ui/tsconfig.json' },
  { kind: 'edit', input: 'ui/tsconfig.json' },
]

afterAll(async () => {
  delete process.env[TOY_ENV]
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

const ids = (pick: (id: string) => boolean): string[] => TOY_TASKS.map((t) => t.id).filter(pick)

/** A first run, then one run per change, each held to the model: the keys
 *  that moved since the run before, the hits, and the stale outputs. */
async function replay(changes: readonly ToyChange[]): Promise<void> {
  let state: ToyState = TOY_START
  let model: ToyRun | undefined
  let before: Observed | undefined
  process.env[TOY_ENV] = valueOf(state, TOY_ENV)
  const cached = await makeToy(state)
  const fresh = await makeToy(state)
  for (const [i, change] of [undefined, ...changes].entries()) {
    if (change !== undefined) state = applyChange(state, change)
    const label = change === undefined ? 'first run' : `step ${i}: ${change.kind} ${change.input}`
    model = toyRun(state, model)
    await writeToy(cached, state)
    await writeToy(fresh, state)
    process.env[TOY_ENV] = valueOf(state, TOY_ENV)
    const real = await vx(cached, true)
    const truth = await vx(fresh, false)
    const prev = before
    expect({
      label,
      moved: prev === undefined ? [] : ids((id) => real.key[id] !== prev.key[id]),
      hit: real.hit,
      stale: ids((id) => real.outputs[id] !== truth.outputs[id]),
    }).toEqual({
      label,
      moved: model.tasks.filter((t) => t.moved !== undefined).map((t) => t.id),
      hit: model.tasks.filter((t) => t.hit).map((t) => t.id),
      stale: model.tasks.filter((t) => t.stale).map((t) => t.id),
    })
    // The graph vx built is the graph the model draws.
    expect(real.deps).toEqual(
      Object.fromEntries(TOY_TASKS.map((t) => [t.id, [...t.dependsOn].sort()])),
    )
    before = real
  }
}

it('the key model moves, hits and goes stale where vx does, step by step', async () => {
  await replay(STEPS)
}, 180_000)

it.each(TOY_SCENARIOS.map((s) => [s.id, s.changes] as const))(
  "the page's %s table is what vx does",
  async (_, changes) => {
    await replay(changes)
  },
  60_000,
)
