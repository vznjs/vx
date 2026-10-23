// Scale guard for the core discover → load-configs → build-task-graph → plan
// pipeline. The platform targets "orgs of 100000s of devs, millions of
// projects", so a super-linear regression anywhere in `prepareRun` +
// `plan` (config eval, package-graph closure, task-graph build, the
// scheduler's reverse-dep priority sweep, per-task hashing, cache probing)
// would make even a `--dry` run lag on a big monorepo. This builds a REAL
// ~2000-project workspace on disk (git-backed, the shape from bench/
// generate.ts) → ~6000 task nodes and pins that `planRun` (the read-only
// --dry path: hashes every task + probes the cache, executes nothing) stays
// well within a generous wall-clock bound.
//
// Methodology mirrors tests/scheduler.test.ts's priority-scale guard: min of
// several runs' CPU time (a crowded machine adds wall, not CPU), a bound ~10x the observed healthy
// time (guarding ALGORITHMIC COMPLEXITY, not absolute speed), and a
// functional pin (the graph is correct at scale, not merely fast).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeEdges } from './helpers/plugin.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planRun } from './helpers/orchestrator.js'
import type { RunPlan } from '../src/orchestrator/index.js'
import { defaultLogger } from '../src/report/logger.js'
import { cpuClock } from './helpers/cpu-clock.js'

const PROJECT_COUNT = 2000
// Requested tasks (bare names fan out across the whole workspace): build +
// test + lint per project = 3 nodes × 2000 = ~6000 task nodes.
const TASKS = ['build', 'test', 'lint']

const CONFIG = `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/index.js dist/out.js' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'node -e "process.exit(0)"' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    },
    lint: { dependsOn: ['^build'] },
  },
}
`

async function generateWorkspace(root: string, count: number): Promise<void> {
  await mkdir(path.join(root, 'packages'), { recursive: true })
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'scale-root', private: true }),
  )
  const edges: Record<string, string[]> = {}

  // Write projects in parallel batches (keeps the FS pipeline busy without
  // opening 6000 fds at once).
  const batch = 250
  for (let start = 0; start < count; start += batch) {
    const jobs: Promise<unknown>[] = []
    for (let i = start; i < Math.min(start + batch, count); i++) {
      const name = `pkg-${String(i).padStart(4, '0')}`
      // A 10-wide dependency band (project i depends on up to 3 of the
      // previous ~10) — real fan-in without a pathological single chain.
      const deps: string[] = []
      for (let k = 1; k <= 3; k++) {
        const j = i - k * 3
        if (j >= 0) deps.push(`pkg-${String(j).padStart(4, '0')}`)
      }
      edges[name] = deps
      const pdir = path.join(root, 'packages', name)
      jobs.push(
        (async () => {
          await mkdir(path.join(pdir, 'src'), { recursive: true })
          await writeFile(
            path.join(pdir, 'package.json'),
            JSON.stringify({ name, version: '0.0.0' }),
          )
          await writeFile(path.join(pdir, 'src', 'index.js'), `export const v = ${i}\n`)
          await writeFile(path.join(pdir, 'vx.config.mjs'), CONFIG)
        })(),
      )
    }
    await Promise.all(jobs)
  }
  await writeEdges(root, edges)

  // vx enumerates inputs via git — the workspace must be a committed repo.
  const git = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.email=t@vx',
        '-c',
        'user.name=t',
        ...args,
      ],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${p.stderr.toString()}`)
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
}

describe('core pipeline at ~2000 projects / ~6000 tasks', () => {
  let root: string
  let warm: RunPlan
  const log = defaultLogger({ enabled: false })

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-scale-graph-'))
    await generateWorkspace(root, PROJECT_COUNT)
    // A warm run: primes the FS/OID cache + JIT so the perf pin measures the
    // steady-state pipeline, and gives the functional pin its graph.
    warm = await planRun({ cwd: root, tasks: TASKS, log })
  }, 300_000)

  // Removing the 2000-project tree is the fixture's work too: 4.2 s on a
  // box with four busy loops beside the suite, against bun's 5 s default,
  // which a loaded gate passed (M-19). The bound matches the work.
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  }, 300_000)

  it('builds the full graph — 6000 nodes with correct shape', () => {
    // Functional pin: bare task names fanned out across every project.
    expect(warm.tasks.length).toBe(PROJECT_COUNT * TASKS.length)

    const byTask = new Map<string, number>()
    const byId = new Map(warm.tasks.map((t) => [t.node.id, t]))
    for (const t of warm.tasks) byTask.set(t.node.taskName, (byTask.get(t.node.taskName) ?? 0) + 1)
    expect(byTask.get('build')).toBe(PROJECT_COUNT)
    expect(byTask.get('test')).toBe(PROJECT_COUNT)
    expect(byTask.get('lint')).toBe(PROJECT_COUNT)

    // `test` depends on the same project's `build` (dependsOn: ['build']).
    const someTest = byId.get('pkg-0500#test')!
    expect(someTest.node.deps).toContain('pkg-0500#build')

    // Cache is empty → every cacheable build is a miss; `lint` (no exec) is a
    // group aggregator.
    expect(byId.get('pkg-0500#build')!.cacheStatus).toBe('miss')
    expect(byId.get('pkg-0500#lint')!.cacheStatus).toBe('group')
  })

  it('plans ~6000 tasks well within a generous wall-clock bound', async () => {
    // Timed in CPU, not wall: on a 4-core box with 24 busy loops beside it,
    // one planRun took 6-18 s of wall and 1.6-1.7 s of CPU, as idle (1.7-1.9 s
    // CPU over ~1 s wall: config eval runs in workers). PR #4169 failed this
    // bound at 6.6 s of wall on a worker booked 3.7 of 4 cores. A
    // super-linear regression (an O(N^2) in the graph builder or priority
    // sweep) costs CPU, so it still crosses the bound.
    let best = Infinity
    let plan: RunPlan | undefined
    for (let i = 0; i < 3; i++) {
      const cpu = cpuClock()
      plan = await planRun({ cwd: root, tasks: TASKS, log })
      best = Math.min(best, cpu())
    }
    // Functional pin alongside the perf pin: the timed runs produced the full
    // graph too (a broken run that returned early would be "fast" but wrong).
    expect(plan!.tasks.length).toBe(PROJECT_COUNT * TASKS.length)
    expect(best).toBeLessThan(6000)
  }, 120_000)
})
