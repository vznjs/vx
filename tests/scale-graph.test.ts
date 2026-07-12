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
// several runs (de-noises machine load), a bound ~10x the observed healthy
// time (guarding ALGORITHMIC COMPLEXITY, not absolute speed), and a
// functional pin (the graph is correct at scale, not merely fast).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planRun } from '../src/orchestrator/index.js'
import type { RunPlan } from '../src/orchestrator/index.js'
import { defaultLogger } from '../src/orchestrator/logger.js'

const PROJECT_COUNT = 2000
// Requested tasks (bare names fan out across the whole workspace): build +
// test + lint per project = 3 nodes × 2000 = ~6000 task nodes.
const TASKS = ['build', 'test', 'lint']

const CONFIG = `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/index.js dist/out.js' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'node -e "process.exit(0)"' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
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

  // Write projects in parallel batches (keeps the FS pipeline busy without
  // opening 6000 fds at once).
  const batch = 250
  for (let start = 0; start < count; start += batch) {
    const jobs: Promise<unknown>[] = []
    for (let i = start; i < Math.min(start + batch, count); i++) {
      const name = `pkg-${String(i).padStart(4, '0')}`
      // A 10-wide dependency band (project i depends on up to 3 of the
      // previous ~10) — real fan-in without a pathological single chain.
      const deps: Record<string, string> = {}
      for (let k = 1; k <= 3; k++) {
        const j = i - k * 3
        if (j >= 0) deps[`pkg-${String(j).padStart(4, '0')}`] = 'workspace:*'
      }
      const pdir = path.join(root, 'packages', name)
      jobs.push(
        (async () => {
          await mkdir(path.join(pdir, 'src'), { recursive: true })
          await writeFile(
            path.join(pdir, 'package.json'),
            JSON.stringify({
              name,
              version: '0.0.0',
              ...(Object.keys(deps).length ? { dependencies: deps } : {}),
            }),
          )
          await writeFile(path.join(pdir, 'src', 'index.js'), `export const v = ${i}\n`)
          await writeFile(path.join(pdir, 'vx.config.mjs'), CONFIG)
        })(),
      )
    }
    await Promise.all(jobs)
  }

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

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

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
    // Calibration (this machine): planRun over 6000 tasks min-of-3 ~= 510 ms
    // (config eval + git OID enumeration + graph build + per-task hashing +
    // cache probes). A super-linear regression (e.g. an accidental O(N^2) in
    // the graph builder or priority sweep) would push this into many seconds.
    // Bound at ~12x the healthy time — separates cleanly while staying robust
    // to CI's slower disk/CPU (the pipeline is FS/SQLite-bound, so noisier
    // than a pure-CPU loop).
    let best = Infinity
    let plan: RunPlan | undefined
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      plan = await planRun({ cwd: root, tasks: TASKS, log })
      best = Math.min(best, performance.now() - t0)
    }
    // Functional pin alongside the perf pin: the timed runs produced the full
    // graph too (a broken run that returned early would be "fast" but wrong).
    expect(plan!.tasks.length).toBe(PROJECT_COUNT * TASKS.length)
    expect(best).toBeLessThan(6000)
  }, 120_000)
})
