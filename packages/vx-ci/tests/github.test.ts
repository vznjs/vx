// @vzn/vx-ci — render tests (pure), plugin activation/decline, and the
// composition proof: a real `vx run` with `github({ summaryFile })` writes
// the job summary. No GitHub API involved in wave one — the summary is a
// file the Actions runner renders.
import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import type { RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { github } from '../src/plugin.js'
import { GithubSummarySink } from '../src/sink.js'
import { MAX_JOB_SUMMARY_BYTES } from '../src/summary.js'
import { renderJobSummary } from '../src/summary.js'

/**
 * Put `process.env` back IN PLACE: assigning a fresh object detaches it
 * from the process environment for every later file in this process.
 */
function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** A path in a fresh directory, nothing written there yet. */
async function fresh(name = 'sumfile.md'): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'vx-gh-sum-')), name)
}
const written = (file: string): Promise<string | undefined> =>
  readFile(file, 'utf8').catch(() => undefined)

const GITHUB_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

const RUN: RunContextRecord = {
  runId: 'run-1',
  vxVersion: '1.2.3',
  workspaceId: 'ws',
  workspaceName: 'fixture',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'local:rw,remote:',
  concurrency: 4,
  flow: 'focused',
} as unknown as RunContextRecord

const task = (over: Partial<TaskTelemetry>): TaskTelemetry =>
  ({
    taskId: 'a#build',
    project: 'a',
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1234,
    ...over,
  }) as TaskTelemetry

const summary = (
  tasks: TaskTelemetry[],
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord => ({
  v: 2,
  run: RUN,
  startedAt: 1,
  endedAt: 2,
  totalDurationMs: 4321,
  taskCount: tasks.length,
  failedCount: tasks.filter((t) => t.status === 'failed').length,
  abortedCount: 0,
  hitCount: tasks.filter((t) => t.status.startsWith('cache-hit')).length,
  hitLocalCount: tasks.filter((t) => t.status === 'cache-hit').length,
  hitRemoteCount: tasks.filter((t) => t.status === 'cache-hit-remote').length,
  upToDateCount: tasks.filter((t) => t.status.startsWith('cache-hit') && t.restored !== true)
    .length,
  restoredLocalCount: tasks.filter((t) => t.status === 'cache-hit' && t.restored === true).length,
  restoredRemoteCount: tasks.filter((t) => t.status === 'cache-hit-remote' && t.restored === true)
    .length,
  exitOk: tasks.every((t) => t.status !== 'failed'),
  tasks,
  ...over,
})

describe('renderJobSummary', () => {
  it('renders verdict, stats, and one row per task', () => {
    const md = renderJobSummary(
      summary([
        task({}),
        task({ taskId: 'a#test', task: 'test', status: 'cache-hit', restored: true }),
        task({ taskId: 'a#lint', task: 'lint', status: 'cache-hit', restored: false }),
        task({ taskId: 'a#e2e', task: 'e2e', status: 'cache-hit-remote', restored: true }),
      ]),
    )
    expect(md).toContain('## ✅ vx run')
    expect(md).toContain('**4** tasks')
    expect(md).toContain('| a#build | ✅ ran | 1.2s |')
    // A hit reads by what it did to the disk, as vx's own summary says it.
    expect(md).toContain('| a#test | ⚡ restored |')
    expect(md).toContain('| a#lint | ✔️ up-to-date |')
    expect(md).toContain('| a#e2e | ☁️ restored remote |')
    expect(md).not.toContain('### Failures')
    expect(md).not.toContain('| Verify |')
  })

  // 2026-10-23: "Sort summary by status and then time".
  it('lists tasks by status, failures first, then the longest first', () => {
    const md = renderJobSummary(
      summary([
        task({ taskId: 'a#short', durationMs: 1_000 }),
        task({ taskId: 'a#hit', status: 'cache-hit', restored: true, durationMs: 9_000 }),
        task({ taskId: 'a#long', durationMs: 5_000 }),
        task({ taskId: 'a#bad', status: 'failed', exitCode: 1, durationMs: 10 }),
        task({ taskId: 'a#same', status: 'cache-hit', restored: false, durationMs: 50 }),
        task({ taskId: 'a#srv', status: 'success', carried: true, durationMs: 0 }),
      ]),
    )
    const rows = md
      .split('\n')
      .filter((l) => l.startsWith('| a#'))
      .map((l) => l.split(' | ')[0]!.slice(2))
    expect(rows).toEqual(['a#bad', 'a#long', 'a#short', 'a#srv', 'a#hit', 'a#same'])
  })

  // Owner, 2026-10-23: the page shows each DTE worker, expected beside used.
  it('names each worker the run used, expected beside used, its peak RAM, and the totals', () => {
    const m = {
      status: 'left',
      cores: 4,
      memoryBytes: 16e9,
      failed: 0,
      cpuPeak: 3,
      memoryPeakBytes: 1e9,
      memoryAvgBytes: 5e8,
    }
    const md = renderJobSummary(
      summary(
        [
          task({ taskId: 'a#test', where: 'small#1' }),
          task({ taskId: 'b#test', where: 'small#1' }),
          task({ taskId: 'c#services', carried: true }),
          task({ taskId: 'e#gen' }),
          task({ taskId: 'd#lint', status: 'cache-hit' }),
        ],
        {
          machines: [
            {
              ...m,
              name: 'small#1',
              done: 3,
              onlineMs: 40_000,
              busyMs: 36_000,
              cpuAvg: 2,
              bookedAvg: 3.9,
              memoryPeakBytes: 9.8e9,
              utilization: 0.5,
              warmUpMs: 21_000,
              startMs: 800,
            },
            {
              ...m,
              name: 'small#2',
              done: 0,
              onlineMs: 10_000,
              busyMs: 0,
              cpuAvg: 0,
              bookedAvg: 0,
              utilization: 0,
              warmUpMs: 90_000,
            },
          ],
        },
      ),
    )
    expect(md).toContain('### Workers')
    // Not a 0 ms run: its time is its dependants' (2026-10-23).
    expect(md).toContain('| c#services | 🔗 served |  |')
    // A carried server ran in its dependants; a task that ran on the run's
    // own machine is named, and the counts add up (2026-10-23).
    expect(md).toContain('| this machine | ok |  |  |  |  |  | 1 |  |  |  |  |')
    expect(md).toContain('3 executed: 2 on workers, 1 on this machine: e#gen.')
    expect(md).toContain(
      '| small#1 | left | 800ms | 1m 1s | 21.0s | 40.0s | 4.0s | 3 | 3.9 of 4 | 2.0 of 4 | 9.8 of 16.0 GB | 50% |',
    )
    expect(md).toContain(
      '| small#2 | left |  | 1m 40s | 1m 30s | 10.0s | 10.0s | 0 | 0.0 of 4 | 0.0 of 4 | 1.0 of 16.0 GB | 0% |',
    )
    expect(md).toContain(
      "Over their online time, tasks booked 78% of the workers' cores and used 40%.",
    )
    expect(renderJobSummary(summary([task({})]))).not.toContain('### Workers')
    // "13 (1 failed)" read as 13 in all (2026-10-23).
    const one = renderJobSummary(
      summary([task({ where: 'small#1' })], {
        machines: [
          {
            ...m,
            name: 'small#1',
            done: 13,
            failed: 1,
            onlineMs: 1,
            busyMs: 1,
            cpuAvg: 0,
            utilization: 0,
          },
        ],
      }),
    )
    expect(one).toContain('| small#1 | left |  | 1ms |  | 1ms | 0ms | 13 ok, 1 failed |')
    expect(one).not.toContain('this machine')
    // The workers line named a task that ran on the run's own machine raw.
    const here = renderJobSummary(
      summary([task({ taskId: 'a#*x*' }), task({ taskId: 'b#y', where: 'w' })], {
        machines: [{ ...m, name: 'w', done: 1, onlineMs: 1, busyMs: 1, cpuAvg: 0, utilization: 0 }],
      }),
    )
    expect(here).toContain('1 on this machine: a#\\*x\\*.')
    // A line break in a task id ended the line: `# y` became a heading.
    const broken = renderJobSummary(
      summary([task({ taskId: 'a#x\n# y' }), task({ taskId: 'b#y', where: 'w' })], {
        machines: [{ ...m, name: 'w', done: 1, onlineMs: 1, busyMs: 1, cpuAvg: 0, utilization: 0 }],
      }),
    )
    expect(broken).toContain('1 on this machine: a#x # y.')
  })

  it('a worker with no booked cores is not read as 0% booked', () => {
    const m = {
      name: 'w',
      status: 'online',
      cores: 4,
      memoryBytes: 16e9,
      memoryPeakBytes: 1e9,
      memoryAvgBytes: 5e8,
      done: 1,
      failed: 0,
      onlineMs: 10_000,
      busyMs: 10_000,
      cpuPeak: 4,
      cpuAvg: 2,
      utilization: 0.5,
    }
    const unbooked = renderJobSummary(
      summary([task({ where: 'w' })], { machines: [m, { ...m, name: 'v' }] }),
    )
    expect(unbooked).toContain("Over their online time, tasks used 50% of the workers' cores.")
    expect(unbooked).not.toContain('booked 0%')
    // Booked share over the workers that report one.
    const mixed = renderJobSummary(
      summary([task({ where: 'w' })], {
        machines: [
          { ...m, bookedAvg: 3 },
          { ...m, name: 'v' },
        ],
      }),
    )
    expect(mixed).toContain(
      "Over their online time, tasks booked 75% of the workers' cores and used 50%.",
    )
  })

  it('failures head the table and get a callout section', () => {
    const md = renderJobSummary(
      summary([task({}), task({ taskId: 'b#build', status: 'failed', exitCode: 2 })]),
    )
    expect(md).toContain('## ❌ vx run')
    expect(md).toContain('### Failures')
    expect(md).toContain('- **b#build** — exit 2\n')
    const rows = md.split('\n').filter((l) => l.startsWith('| '))
    // rows[0] header, rows[1] separator; the first DATA row is the failure
    expect(rows[2]).toContain('b#build')
  })

  it('a failure names the tasks it blocked', () => {
    const md = renderJobSummary(
      summary([
        task({ taskId: 'lib#build', status: 'failed', exitCode: 3 }),
        task({ taskId: 'app#build', status: 'skipped', exitCode: 1, blockedBy: 'lib#build' }),
        task({ taskId: 'web#build', status: 'skipped', exitCode: 1, blockedBy: 'lib#build' }),
        task({ taskId: 'x#build', status: 'skipped', exitCode: 1 }),
      ]),
    )
    expect(md).toContain('- **lib#build** — exit 3 · blocked app#build, web#build\n')
  })

  it('what failures blocked is found in one pass, however many failed', () => {
    // A scan of every task per failure: 10 000 failures of 20 000 tasks
    // rendered in 1.3 s, 35 ms grouped (F-38).
    const walks = (failures: number): number => {
      const tasks = Array.from({ length: failures }, (_, i) => [
        task({ taskId: `f${i}#build`, status: 'failed', exitCode: 1 }),
        task({ taskId: `s${i}#build`, status: 'skipped', exitCode: 1, blockedBy: `f${i}#build` }),
      ]).flat()
      const s = summary(tasks)
      let n = 0
      const counted = new Proxy(s.tasks, {
        get(target, key, receiver) {
          if (key === 'filter' || key === 'map' || key === 'forEach' || key === Symbol.iterator) n++
          return Reflect.get(target, key, receiver)
        },
      })
      const md = renderJobSummary({ ...s, tasks: counted })
      expect(md).toContain(
        `- **f${failures - 1}#build** — exit 1 · blocked s${failures - 1}#build\n`,
      )
      return n
    }
    expect(walks(50)).toBe(walks(1))
  })

  it('a persistent task that never became ready reads its reason', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#dev', status: 'failed', exitCode: 1, notReady: 'timeout' })]),
    )
    expect(md).toContain('- **b#dev** — never ready (timed out), exit 1\n')
  })

  it('a sandboxed failure counts its violations', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#build', status: 'failed', exitCode: 1, sandboxViolations: 2 })]),
    )
    expect(md).toContain('- **b#build** — exit 1 · 2 sandbox violations\n')
  })

  it('a timeout reads as the reason, not as the signal its exit is', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#build', status: 'failed', exitCode: 143, timedOut: true })]),
    )
    expect(md).toContain('- **b#build** — timed out, exit 143\n')
  })

  it('a failure above 128 names the signal its exit stands for', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#build', status: 'failed', exitCode: 137 })]),
    )
    expect(md).toContain('- **b#build** — exit 137 (128 + SIGKILL)\n')
  })

  it('escapes pipes in task ids — a hostile name cannot break the table', () => {
    const md = renderJobSummary(summary([task({ taskId: 'a#e|vil' })]))
    expect(md).toContain('a#e\\|vil')
  })
})

describe('github() activation', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }

  it('declines outside GitHub Actions (no GITHUB_STEP_SUMMARY, no option)', () => {
    const prev = process.env['GITHUB_STEP_SUMMARY']
    delete process.env['GITHUB_STEP_SUMMARY']
    try {
      expect(github()!.telemetry!(ctx)).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env['GITHUB_STEP_SUMMARY'] = prev
    }
  })

  it('activates on the env var and writes via flush, not onRunSummary', async () => {
    const file = await fresh()
    const sink = github({ summaryFile: file })!.telemetry!(ctx) as GithubSummarySink
    expect(sink).toBeInstanceOf(GithubSummarySink)
    sink.onRunSummary!(summary([task({})]))
    expect(await written(file)).toBeUndefined() // prompt-return contract: no I/O here
    await sink.flush!()
    expect(await written(file)).toContain('a#build')
  })

  it('what it appends is bounded by GitHub’s 1 MiB job-summary cap', async () => {
    // GitHub rejects a step summary past 1 MiB outright — so an
    // unbounded page costs the whole summary, not its tail. At the measured
    // ~55 bytes a row that is ~19 000 tasks, which this repo's own bench
    // generates (5 000 projects × four tasks), so it is reachable
    // (2026-09-20).
    const file = await fresh()
    const sink = github({ summaryFile: file })!.telemetry!(ctx) as GithubSummarySink
    const many = Array.from({ length: 25_000 }, (_, i) =>
      task({ taskId: `project-with-a-long-name-${i}#build` }),
    )
    sink.onRunSummary!(summary(many))
    await sink.flush!()
    const text = (await written(file))!
    expect({ overCap: text.length > MAX_JOB_SUMMARY_BYTES }).toEqual({ overCap: false })
    expect(text).toContain('truncated by @vzn/vx-ci')
    // The head survives: the verdict and the stats line are what a reader
    // needs, and they are rendered before the table.
    expect(text.startsWith('## ')).toBe(true)
    expect(text).toContain('**25000** tasks')
  })

  it('the cap is the step file’s: what other writers left is the room (F-42)', async () => {
    // GitHub caps the step's whole summary file; a page clamped to 1 MiB
    // after 900 KB of another tool's output made 1.9 MiB, refused whole.
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-sum-'))
    try {
      const run = async (already: number): Promise<{ size: number; warns: string[] }> => {
        const file = path.join(dir, `summary-${already}.md`)
        await writeFile(file, 'x'.repeat(already))
        const warns: string[] = []
        const sink = github({ summaryFile: file })!.telemetry!({
          ...ctx,
          warn: (m: string) => warns.push(m),
        }) as GithubSummarySink
        const many = Array.from({ length: 25_000 }, (_, i) =>
          task({ taskId: `project-with-a-long-name-${i}#build` }),
        )
        sink.onRunSummary!(summary(many))
        await sink.flush!()
        return { size: (await stat(file)).size, warns }
      }
      const shared = await run(900_000)
      expect(shared.size).toBeLessThanOrEqual(MAX_JOB_SUMMARY_BYTES)
      expect(shared.size).toBeGreaterThan(900_000)
      const full = await run(MAX_JOB_SUMMARY_BYTES - 10)
      expect(full.size).toBe(MAX_JOB_SUMMARY_BYTES - 10)
      expect(full.warns).toEqual([
        `[vx] vx-ci: ${path.join(dir, `summary-${MAX_JOB_SUMMARY_BYTES - 10}.md`)} already holds ${MAX_JOB_SUMMARY_BYTES - 10} bytes of GitHub's 1 MiB job summary cap — no room for vx's page`,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Every plugin warning says `[vx]` first: this one said `vx-ci:` alone.
  it('a summary it cannot write is warned with the [vx] tag', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-sum-'))
    try {
      const warns: string[] = []
      const sink = github({ summaryFile: dir })!.telemetry!({
        ...ctx,
        warn: (m: string) => warns.push(m),
      }) as GithubSummarySink
      sink.onRunSummary!(summary([task({ taskId: 'a#build' })]))
      await sink.flush!()
      expect(warns.map((w) => w.slice(0, w.indexOf(dir) + dir.length))).toEqual([
        `[vx] vx-ci: could not write the job summary to ${dir}`,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // F-51: a step writer that left no final newline (`printf 'coverage 91%'`)
  // ran vx's heading into its paragraph. The page starts on its own line.
  it('the page starts on a new line after another writer; an empty file gets none', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-sum-'))
    try {
      const run = async (before: string): Promise<string> => {
        const file = path.join(dir, `s-${before.length}.md`)
        await writeFile(file, before)
        const sink = github({ summaryFile: file })!.telemetry!(ctx) as GithubSummarySink
        sink.onRunSummary!(summary([task({})]))
        await sink.flush!()
        return (await readFile(file, 'utf8')).split('\n').slice(0, 2).join('\n')
      }
      expect([await run('coverage 91%'), await run('')]).toEqual([
        'coverage 91%\n## ✅ vx run',
        '## ✅ vx run\n',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('CONTROL: an ordinary summary is appended whole, with no truncation tell', async () => {
    const file = await fresh()
    const sink = github({ summaryFile: file })!.telemetry!(ctx) as GithubSummarySink
    sink.onRunSummary!(summary([task({}), task({ taskId: 'b#build' })]))
    await sink.flush!()
    expect(await written(file)).not.toContain('truncated by @vzn/vx-ci')
    expect(await written(file)).toContain('b#build')
  })

  it('a run with no summary emitted flushes to nothing', async () => {
    const file = await fresh()
    const sink = github({ summaryFile: file })!.telemetry!(ctx) as GithubSummarySink
    await sink.flush!()
    expect(await written(file)).toBeUndefined()
  })
})

describe('vx run with github() — the composition proof', () => {
  it('a real run appends the job summary with the executed tasks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-run-github-'))
    try {
      const summaryFile = path.join(root, 'step-summary.md')
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n")
      await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
      await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'x\n')
      await writeFile(
        path.join(root, 'pkg', 'vx.config.mjs'),
        `export default { tasks: {
           build: {
             exec: { command: 'cat src/in.txt > out.txt' },
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [`github({ summaryFile: ${JSON.stringify(summaryFile)} })`],
          `import { github } from ${JSON.stringify(GITHUB_INDEX)}\n`,
        ),
      )
      const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
      git('init', '-q')
      const r = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: {
          status: () => undefined,
          error: () => undefined,
        } as never,
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      const md = await readFile(summaryFile, 'utf8')
      expect(md).toContain('## ✅ vx run')
      expect(md).toContain('pkg#build')
      expect(md).toContain('✅ ran')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Item 806's sweep: each row fails with one line of src/ undone.
describe('every output the vx-ci sweep found unheld', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const row = (md: string, id: string) => md.split('\n').find((l) => l.startsWith(`| ${id} |`))

  it('the job summary is clamped in BYTES, on a character boundary', async () => {
    // Ids of 2-byte letters and a 3-byte `⚡` a row: under the cap in UTF-16
    // units, well past it in bytes, and the old clamp passed the page whole
    // (item 806).
    const { clampJobSummary } = await import('../src/summary.js')
    const many = Array.from({ length: 20_000 }, (_, i) =>
      task({ taskId: `żółć-żółć-żółć-${i}#build`, status: 'cache-hit', restored: true }),
    )
    const page = renderJobSummary(summary(many))
    expect({ units: page.length < MAX_JOB_SUMMARY_BYTES }).toEqual({ units: true })
    expect({ bytes: Buffer.byteLength(page, 'utf8') > MAX_JOB_SUMMARY_BYTES }).toEqual({
      bytes: true,
    })
    const written = clampJobSummary(page)
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(MAX_JOB_SUMMARY_BYTES)
    expect(written).toContain('truncated by @vzn/vx-ci')
    expect(written).not.toContain('�')
  })

  it('a cut that lands inside a character backs off to its start, whichever parity', async () => {
    // 2-byte letters behind an optional 1-byte prefix: one of the two puts
    // the cut mid-character, where decoding the half left a U+FFFD that
    // also pushed the page past the cap.
    const { clampJobSummary } = await import('../src/summary.js')
    for (const prefix of ['', 'a']) {
      const written = clampJobSummary(prefix + 'ż'.repeat(MAX_JOB_SUMMARY_BYTES / 2 + 10))
      expect({
        prefix,
        replaced: written.includes('\uFFFD'),
        overCap: Buffer.byteLength(written, 'utf8') > MAX_JOB_SUMMARY_BYTES,
      }).toEqual({ prefix, replaced: false, overCap: false })
    }
  })

  it.each([
    [999, '999ms'],
    [1000, '1.0s'],
    [59_999, '1m 0s'],
    [60_000, '1m 0s'],
    [125_000, '2m 5s'],
  ])('a duration of %d ms reads %s', (ms, shown) => {
    expect(row(renderJobSummary(summary([task({ durationMs: ms })])), 'a#build')).toBe(
      `| a#build | ✅ ran | ${shown} |`,
    )
  })

  it('a status without a label passes through as itself', () => {
    const md = renderJobSummary(summary([task({ status: 'mystery' as TaskTelemetry['status'] })]))
    expect(row(md, 'a#build')).toBe('| a#build | mystery | 1.2s |')
  })

  it('the stats line counts executed tasks, hits by source and failures, singular and plural', () => {
    const four = renderJobSummary(
      summary([
        task({ taskId: 'a#1' }),
        task({ taskId: 'a#2', status: 'failed', exitCode: 1 }),
        task({ taskId: 'a#3', status: 'cache-hit', restored: false }),
        task({ taskId: 'a#4', status: 'cache-hit-remote', restored: true }),
      ]),
    )
    expect(four.split('\n')[2]).toBe(
      '**4** tasks · **2** executed · **2** cache hits (1 up-to-date, 1 restored, 1 from remote) · **1** failed · 4.3s',
    )
    const one = renderJobSummary(summary([task({})]))
    expect(one.split('\n')[2]).toBe('**1** task · **1** executed · **0** cache hits · 4.3s')
    // 2026-10-23: the ideal time of a distributed run, beside the real one.
    const ideal = renderJobSummary(summary([task({})], { idealMs: 3_000 }))
    expect(ideal.split('\n')[2]).toBe(
      '**1** task · **1** executed · **0** cache hits · 4.3s (ideal 3.0s)',
    )
  })

  it('a persistent task that failed to spawn reads so', () => {
    const md = renderJobSummary(
      summary([task({ status: 'failed', exitCode: 127, notReady: 'spawn' })]),
    )
    expect(md).toContain('- **a#build** — never ready (spawn failed), exit 127\n')
  })

  it('the footer counts a hit as passed and escapes the command; a blocked id is escaped', () => {
    const md = renderJobSummary(
      summary(
        [
          task({}),
          task({ taskId: 'a#test', status: 'cache-hit', restored: true }),
          task({ taskId: 'a#lint', status: 'cache-hit', restored: false }),
          task({ taskId: 'x#y', status: 'failed', exitCode: 1 }),
          task({ taskId: 'p|q#t', status: 'skipped', blockedBy: 'x#y' }),
        ],
        { run: { ...RUN, command: 'vx run a|b' } },
      ),
    )
    // Outside a table a `|` needs no escape, and `\\|` rendered literally
    // inside the code span (item 1058).
    // `restored` counts only the hit that wrote outputs; it counted both.
    expect(md).toContain('· `vx run a|b` · 3/5 passed · 1 up-to-date · 1 restored</sub>')
    expect(md).toContain('· blocked p\\|q#t')
  })

  // A backtick in the command ended the footer's code span early, and a
  // task id's `*` rendered as emphasis (item 1058).
  it('the footer holds any command in one code span; an id is escaped as inline markdown', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'a#*x*', status: 'failed', exitCode: 1 })], {
        run: { ...RUN, command: 'vx run `echo` -- x' },
      }),
    )
    expect(md).toContain('· ``vx run `echo` -- x`` · ')
    expect(md).toContain('- **a#\\*x\\*** — exit 1')
  })

  // GitHub reads `~x~` as strikethrough and `&lt;` as `<`: a task named so
  // rendered struck through, or as another name.
  it('an id escapes the strikethrough tilde and an entity', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'a#~x~&lt;', status: 'failed', exitCode: 1 })]),
    )
    expect(md).toContain('- **a#\\~x\\~\\&lt;** — exit 1')
  })

  it('an empty GITHUB_STEP_SUMMARY declines like a missing one', () => {
    const prev = { ...process.env }
    process.env['GITHUB_STEP_SUMMARY'] = ''
    try {
      expect(github()!.telemetry!(ctx)).toBeUndefined()
    } finally {
      restoreEnv(prev)
    }
  })
})

// F-6: the mutation sweep of vx-ci (147 mutants, 31 real survivors).
describe('what the F-6 sweep found unheld', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const durationOf = (ms: number): string =>
    renderJobSummary(summary([task({ durationMs: ms })]), 'vx run')
      .split('\n')
      .find((l) => l.startsWith('| a#build |'))!
      .split(' | ')[2]!
      .replace(' |', '')

  it('a duration rounds before it splits: 119.7 s is 2m 0s, not 1m 60s', () => {
    expect([119_700, 61_000, 3_599_600].map(durationOf)).toEqual(['2m 0s', '1m 1s', '60m 0s'])
  })

  // F-51: each tier rounded its own way, so a duration that rounds up to the
  // next tier printed in the one below: 59.96 s as `60.0s`, 999.6 ms as `1000ms`.
  it('a duration that rounds up to the next tier prints in it', () => {
    expect([59_960, 999.6, 59_940, 999.4].map(durationOf)).toEqual([
      '1m 0s',
      '1.0s',
      '59.9s',
      '999ms',
    ])
  })

  // F-51: CommonMark reads a lone CR as a line ending; the footer's code
  // span kept it, and the span broke across two lines.
  it('a CR in the command is a space in the footer, like a newline', () => {
    const md = renderJobSummary(
      summary([task({})], { run: { ...RUN, command: 'vx run a\rb\r\nc' } }),
    )
    expect(md).toContain('· `vx run a b c` · ')
  })

  it('the page ends in a newline, so a second run in the step starts its own heading', () => {
    expect(renderJobSummary(summary([task({})]), 'vx run').endsWith('\n')).toBe(true)
  })

  it('GITHUB_STEP_SUMMARY alone activates it, and is where the summary goes', async () => {
    const prev = { ...process.env }
    const file = await fresh('from-env.md')
    process.env['GITHUB_STEP_SUMMARY'] = file
    try {
      const sink = github()!.telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
    } finally {
      restoreEnv(prev)
    }
    expect(await written(file)).toContain('a#build')
  })
})

// F-55: a mutation sweep of summary.ts and plugin.ts (206 mutants, 19 real
// survivors) found these unheld.
describe('the summary, as its second sweep found it unheld', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const line = (md: string, prefix: string) => md.split('\n').find((l) => l.startsWith(prefix))

  it('failures beside aborts are a failed run, not a cancelled one', () => {
    const md = renderJobSummary(
      summary(
        [
          task({ status: 'failed', exitCode: 1 }),
          task({ taskId: 'b#build', status: 'aborted' as TaskTelemetry['status'] }),
        ],
        { abortedCount: 1, exitOk: false },
      ),
    )
    expect(md.split('\n')[0]).toBe('## ❌ vx run')
    // Only the failure is a Failure: the aborted task is in the table alone.
    expect(md).toContain('- **a#build** — exit 1\n')
    expect(md).not.toContain('- **b#build**')
  })

  it('violations: none says nothing, one is singular, two plural', () => {
    const failure = (sandboxViolations: number) =>
      line(
        renderJobSummary(summary([task({ status: 'failed', exitCode: 1, sandboxViolations })])),
        '- **a#build**',
      )
    expect([failure(0), failure(1), failure(2)]).toEqual([
      '- **a#build** — exit 1',
      '- **a#build** — exit 1 · 1 sandbox violation',
      '- **a#build** — exit 1 · 2 sandbox violations',
    ])
  })

  it('each task is one table row, the failures first', () => {
    const md = renderJobSummary(
      summary([
        task({}),
        task({ taskId: 'x#y', status: 'failed', exitCode: 1 }),
        task({ taskId: 'c#d' }),
      ]),
    )
    expect(md.split('\n').filter((l) => /^\| (a#build|x#y|c#d) \|/.test(l))).toEqual([
      '| x#y | ❌ failed | 1.2s |',
      '| a#build | ✅ ran | 1.2s |',
      '| c#d | ✅ ran | 1.2s |',
    ])
  })

  it('90 s reads 1m 30s', () => {
    const md = renderJobSummary(summary([task({ durationMs: 90_000 })]))
    expect(line(md, '| a#build |')).toBe('| a#build | ✅ ran | 1m 30s |')
  })

  it('every inline class is escaped in an id: in the table, a failure and a blocked id', () => {
    const id = 'a#\\`_[x]<!--'
    const esc = 'a#\\\\\\`\\_\\[x\\]\\<!--'
    const md = renderJobSummary(
      summary([
        task({ taskId: id, status: 'failed', exitCode: 1 }),
        task({ taskId: `b${id}`, status: 'skipped', blockedBy: id }),
      ]),
    )
    expect([line(md, `| ${esc} |`), line(md, `- **${esc}**`)]).toEqual([
      `| ${esc} | ❌ failed | 1.2s |`,
      `- **${esc}** — exit 1 · blocked b${esc}`,
    ])
  })

  it('a code span holds a run of backticks and one at either end', () => {
    const footer = (command: string) =>
      line(renderJobSummary(summary([task({})], { run: { ...RUN, command } })), '<sub>')!.split(
        ' · ',
      )[1]
    expect([footer('a ``b`` c'), footer('`a'), footer('a`')]).toEqual([
      '```a ``b`` c```',
      '`` `a ``',
      '`` a` ``',
    ])
  })

  it('the summaryFile option wins over GITHUB_STEP_SUMMARY', async () => {
    const prev = process.env['GITHUB_STEP_SUMMARY']
    const fromEnv = await fresh('from-env.md')
    const fromOption = await fresh('from-option.md')
    process.env['GITHUB_STEP_SUMMARY'] = fromEnv
    try {
      const sink = github({ summaryFile: fromOption })!.telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
      expect(await written(fromOption)).toContain('a#build')
      expect(await written(fromEnv)).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env['GITHUB_STEP_SUMMARY']
      else process.env['GITHUB_STEP_SUMMARY'] = prev
    }
  })

  it('after a one-byte file the page still starts on its own line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-lead-'))
    try {
      const file = path.join(dir, 's.md')
      await writeFile(file, 'x')
      const sink = github({ summaryFile: file })!.telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
      expect((await readFile(file, 'utf8')).startsWith('x\n## ✅ vx run')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
