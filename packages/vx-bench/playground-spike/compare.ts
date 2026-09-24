// W9 spike (item 676): does the browser bundle plan exactly what the CLI plans?
//
//   bun packages/vx-bench/playground-spike/build.ts      (first: writes dist/entry.js)
//   bun packages/vx-bench/playground-spike/compare.ts    [SPIKE_TMP=<dir>, default os.tmpdir()]
//
// The fixture (fixture.ts) is written to a temporary directory and
// committed to a fresh git repository. Per scenario:
//   CLI    — `bun packages/vx/src/bin.ts run build ci --all --dry=json` in a subprocess:
//            the real planner, real git, real disk, real Bun;
//   bundle — `planPlayground` from dist/entry.js over the same files held in
//            memory, with the host's Bun APIs and `node:fs` TRAPPED (each
//            replaced by a function that counts and throws) for the whole
//            call, so a reach past the shim fails the scenario loudly.
// Compared: the set of task ids, and every task's key, cache status and
// deps. The scheduler is compared too: the bundle's `computeReverseDepCount`
// priorities and `runGraph` dispatch order against core's source run on the
// CLI's graph. Scenarios: the committed tree; an env change; an UNCOMMITTED
// edit (the CLI hashes the dirty file from disk, not the index). A negative
// control plans the bundle under the wrong env and must differ, on exactly
// the tasks that fold `API_URL` and their dependents. Exits 1 on any
// unexpected result.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { computeReverseDepCount, runGraph } from '../../vx/src/graph/scheduler.js'
import type { TaskNode } from '../../vx/src/graph/index.js'
import { CONFIGS, ENV, FILES } from './fixture.js'

interface PlanTask {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: string
  deps: string[]
}

type PlanPlayground = (input: {
  root: string
  files: Record<string, string>
  configs: Record<string, unknown>
  env: Record<string, string>
  tasks: string[]
  concurrency?: number
}) => Promise<{
  tasks: PlanTask[]
  priorities: Record<string, number>
  dispatchOrder: string[]
  platformCalls: Record<string, number>
  vfsReads: number
  unresolvedTasks: string[]
}>

const here = import.meta.dir
// `ci` is a group task (no exec): its key is `computeGroupHash` over its deps.
const TASKS = ['build', 'ci']
const bin = path.join(here, '../../vx/src/bin.ts')
const bundlePath = path.join(here, 'dist/entry.js')
if (!fs.existsSync(bundlePath)) {
  console.error('no dist/entry.js — run build.ts first')
  process.exit(1)
}

const ws = mkdtempSync(path.join(process.env.SPIKE_TMP ?? os.tmpdir(), 'pg-spike-'))
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
write(FILES)
git('init', '-q')
git('add', '-A')
git('-c', 'user.email=spike@vx', '-c', 'user.name=spike', 'commit', '-qm', 'fixture')

function cliPlan(env: Record<string, string>): PlanTask[] {
  const r = Bun.spawnSync(['bun', bin, 'run', ...TASKS, '--all', '--dry=json'], {
    cwd: ws,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`CLI exited ${r.exitCode}: ${r.stderr.toString()}`)
  return (JSON.parse(r.stdout.toString()) as { tasks: PlanTask[] }).tasks
}

// ---- traps: the host's platform, made to throw while the bundle runs ----
const trapHits: Record<string, number> = {}
const restores: Array<() => void> = []
const notTrappable: string[] = []
function trap(obj: Record<string, unknown>, key: string, label: string): void {
  const orig = obj[key]
  const fn = (): never => {
    trapHits[label] = (trapHits[label] ?? 0) + 1
    throw new Error(`trapped: the bundle reached the host's ${label}`)
  }
  try {
    obj[key] = fn
  } catch {
    // fall through to the check below
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
  const bun = Bun as unknown as Record<string, unknown>
  trap(Bun.hash as unknown as Record<string, unknown>, 'xxHash3', 'Bun.hash.xxHash3')
  for (const k of ['Glob', 'file', 'spawn', 'spawnSync', 'CryptoHasher', 'nanoseconds', 'write']) {
    trap(bun, k, `Bun.${k}`)
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

// Load the bundle BEFORE arming: loading reads the file through the host.
const { planPlayground } = (await import(bundlePath)) as { planPlayground: PlanPlayground }

async function bundlePlan(files: Record<string, string>, env: Record<string, string>) {
  arm()
  try {
    return await planPlayground({ root: '/ws', files, configs: CONFIGS, env, tasks: TASKS })
  } finally {
    disarm()
  }
}

async function nativeSchedule(tasks: PlanTask[]) {
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
    concurrency: 2,
    priorities,
    execute: async (node) => {
      dispatchOrder.push(node.id)
      return { node, status: 'success', exitCode: 0, durationMs: 0 }
    },
  })
  return { priorities: Object.fromEntries(priorities), dispatchOrder }
}

function firstDifference(cli: PlanTask[], web: PlanTask[]): string | null {
  const ids = (ts: PlanTask[]): string =>
    ts
      .map((t) => t.id)
      .sort()
      .join(',')
  if (ids(cli) !== ids(web)) return `task sets differ: CLI [${ids(cli)}] vs bundle [${ids(web)}]`
  const byId = new Map(web.map((t) => [t.id, t]))
  for (const c of cli) {
    const w = byId.get(c.id)!
    for (const field of ['hash', 'cacheStatus', 'project', 'task'] as const) {
      if (c[field] !== w[field]) return `${c.id}.${field}: CLI ${c[field]} vs bundle ${w[field]}`
    }
    if ([...c.deps].sort().join(',') !== [...w.deps].sort().join(',')) {
      return `${c.id}.deps: CLI [${c.deps.join(',')}] vs bundle [${w.deps.join(',')}]`
    }
  }
  return null
}

const scenarios: Array<{
  name: string
  env: Record<string, string>
  edits: Record<string, string>
}> = [
  { name: 'committed tree', env: ENV, edits: {} },
  { name: 'env change (API_URL)', env: { API_URL: 'https://staging.example.test' }, edits: {} },
  {
    name: 'uncommitted edit (@pg/utils src)',
    env: ENV,
    edits: { 'packages/utils/src/strings.ts': 'export const shout = (s: string) => `${s}!`\n' },
  },
]

let failed = false
const report: Record<string, unknown>[] = []
let baseline: PlanTask[] = []
for (const sc of scenarios) {
  write({ ...FILES, ...sc.edits })
  const cli = cliPlan(sc.env)
  const web = await bundlePlan({ ...FILES, ...sc.edits }, sc.env)
  const native = await nativeSchedule(cli)
  const diff = firstDifference(cli, web.tasks)
  const prioritiesEqual = JSON.stringify(native.priorities) === JSON.stringify(web.priorities)
  const orderEqual = native.dispatchOrder.join(',') === web.dispatchOrder.join(',')
  if (sc.name === 'committed tree') baseline = cli
  const changedVsBaseline = cli
    .filter((t) => baseline.find((b) => b.id === t.id)?.hash !== t.hash)
    .map((t) => t.id)
    .sort()
  if (diff !== null || !prioritiesEqual || !orderEqual) failed = true
  report.push({
    scenario: sc.name,
    tasks: cli.length,
    keysEqual: diff === null,
    firstDifference: diff,
    prioritiesEqual,
    dispatchOrderEqual: orderEqual,
    keysChangedVsCommittedTree: changedVsBaseline,
    bundlePlatformCalls: web.platformCalls,
    bundleVfsReads: web.vfsReads,
  })
}
write(FILES)

// Negative control: the bundle under the wrong env must NOT match the
// committed-tree CLI plan, and must differ exactly where API_URL reaches.
const wrong = await bundlePlan(FILES, { API_URL: 'https://wrong.example.test' })
const differing = baseline
  .filter((t) => wrong.tasks.find((w) => w.id === t.id)?.hash !== t.hash)
  .map((t) => t.id)
  .sort()
const expectedDiffering = [
  '@pg/app#build',
  '@pg/app#ci',
  '@pg/core#build',
  '@pg/core#test',
  '@pg/ui#build',
]
const controlHolds = JSON.stringify(differing) === JSON.stringify(expectedDiffering)
if (!controlHolds) failed = true

const trapped = Object.keys(trapHits).length > 0
if (trapped || notTrappable.length > 0) failed = true

console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      fixture: ws,
      scenarios: report,
      negativeControl: { differing, expectedDiffering, holds: controlHolds },
      hostApisTrapped: {
        reachedByBundle: trapHits,
        couldNotTrap: notTrappable,
      },
      committedTreePlan: baseline.map((t) => ({
        id: t.id,
        hash: t.hash,
        cacheStatus: t.cacheStatus,
        deps: t.deps,
      })),
    },
    null,
    2,
  ),
)
if (process.env.KEEP_FIXTURE === undefined) rmSync(ws, { recursive: true, force: true })
if (failed) process.exit(1)
