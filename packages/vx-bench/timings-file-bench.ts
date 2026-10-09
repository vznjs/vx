// The CI timings file, measured on real runs: a cold runner with no
// history, one with `scheduleHistoryPlugin({ file })` carrying the last
// run's timings, and one with this machine's full history. Every task is
// uncached, so every run executes all of them and only the ORDER differs.
//
//   bun packages/vx-bench/timings-file-bench.ts [--reps N] [--json]
//
// The graph is where order matters: eight packages whose `build → check →
// pack` chains unlock work (0.5 s a task), and three slow leaf tasks
// (`e2e`, 10 s) nothing depends on. With no timings, the scheduler favours
// the tasks with the most work behind them, so the slow leaves start last.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run, type Logger } from '@vzn/vx'

const PLUGIN = path.resolve(import.meta.dir, '..', 'vx-schedule-history', 'src', 'index.ts')
const WORKERS = 4
const LIBS = 8
const SLOW = 3
const SHORT_S = 0.5
const SLOW_S = 10

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const REPS = Number(arg('--reps') ?? 3)

type Arm = 'cold, no file' | 'cold, with file' | 'full local history'
const ARMS: readonly Arm[] = ['cold, no file', 'cold, with file', 'full local history']

const quiet: Logger = {
  status() {},
  taskStart() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
} as unknown as Logger

async function workspace(root: string, file: boolean): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const pkg = async (name: string, tasks: Record<string, unknown>): Promise<void> => {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default ${JSON.stringify({ tasks })}\n`,
    )
  }
  const sleep = (s: number) => ({ exec: { command: `sleep ${s}` } })
  for (let i = 0; i < SLOW; i++) await pkg(`app-${i}`, { e2e: sleep(SLOW_S) })
  for (let i = 0; i < LIBS; i++)
    await pkg(`lib-${i}`, {
      build: sleep(SHORT_S),
      check: { ...sleep(SHORT_S), dependsOn: ['build'] },
      pack: { ...sleep(SHORT_S), dependsOn: ['check'] },
    })
  const options = file ? "{ file: 'timings.json' }" : ''
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN)}\n` +
      `export default { cacheDir: '.cache', plugins: [scheduleHistoryPlugin(${options})] }\n`,
  )
}

async function wall(root: string): Promise<number> {
  const t0 = performance.now()
  const summary = await run({
    cwd: root,
    tasks: ['e2e', 'build', 'check', 'pack'],
    concurrency: WORKERS,
    handleSignals: false,
    log: quiet,
  })
  if (!summary.ok) throw new Error('a bench run failed')
  return (performance.now() - t0) / 1000
}

async function arm(which: Arm): Promise<number[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-timings-bench-'))
  try {
    await workspace(root, which === 'cold, with file')
    // One run first: it writes the file (with-file arm) or the history.
    if (which !== 'cold, no file') await wall(root)
    const times: number[] = []
    for (let r = 0; r < REPS; r++) {
      if (which !== 'full local history') {
        await rm(path.join(root, '.cache'), { recursive: true, force: true })
      }
      times.push(await wall(root))
    }
    return times
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const work = SLOW * SLOW_S + LIBS * 3 * SHORT_S
const results: Record<string, number[]> = {}
for (const a of ARMS) results[a] = await arm(a)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ workers: WORKERS, reps: REPS, results }, null, 2))
} else {
  console.log(
    `${LIBS * 3} chained tasks of ${SHORT_S} s, ${SLOW} leaves of ${SLOW_S} s, ${WORKERS} workers; ` +
      `lower bound ${Math.max(SLOW_S, work / WORKERS).toFixed(1)} s`,
  )
  for (const a of ARMS) {
    const t = results[a]!
    console.log(
      `${a.padEnd(20)} min ${Math.min(...t).toFixed(2)} s  (${t.map((x) => x.toFixed(2)).join(', ')})`,
    )
  }
}
