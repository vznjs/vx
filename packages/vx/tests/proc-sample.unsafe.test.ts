// The live sampler reads the host's process table: under the sandbox's
// own pid namespace /proc is a table of strangers, so this is unsafe.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { psTimeMs, sampleTrees } from '../src/exec/proc-sample.js'
import { run } from '../src/index.js'
import {
  createTelemetrySource,
  type RunContextRecord,
  type TelemetryRecord,
} from '../src/orchestrator/telemetry.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A root `sh` that waits on a grandchild burning one core. */
function burner(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['sh', '-c', 'sh -c "while :; do :; done" & wait'], {
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
}

const BURN_MS = 500

/**
 * A root `sh` that waits on a grandchild Bun which burns until its own CPU
 * reaches BURN_MS, writes `done` to `marker`, then idles: a known quantity
 * of work, however far contention stretches the wall.
 */
function fixedBurner(marker: string): ReturnType<typeof Bun.spawn> {
  const script = `
    const want = ${BURN_MS} * 1000
    for (;;) { const u = process.cpuUsage(); if (u.user + u.system >= want) break }
    require('node:fs').writeFileSync(process.env.MARKER, 'done')
    setInterval(() => {}, 1 << 30)
  `
  return Bun.spawn(['sh', '-c', '"$0" -e "$1" & wait', process.execPath, script], {
    env: { ...process.env, MARKER: marker },
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
}

function stop(child: ReturnType<typeof Bun.spawn>): void {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

describe('sampleTrees', () => {
  it("sums a tree's CPU in ms and memory in bytes, the grandchild's included", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-proc-sample-'))
    roots.push(dir)
    const marker = path.join(dir, 'burned')
    const child = fixedBurner(marker)
    try {
      while (!existsSync(marker) || readFileSync(marker, 'utf8') !== 'done') await Bun.sleep(20)
      const usage = (await sampleTrees([child.pid])).get(child.pid)
      // The idle root spends ~0: the CPU is the grandchild's, which stopped
      // burning at BURN_MS of its own. A wrong tick (100 Hz assumed) or a
      // tree that stops at the root reads 10× off or 0. Bounded by the work
      // done, not the wall: a descheduled child accrues wall but not CPU.
      expect(usage).toBeDefined()
      expect(usage!.cpuMs).toBeGreaterThan(BURN_MS * 0.9)
      expect(usage!.cpuMs).toBeLessThan(BURN_MS * 2)
      // A shell and a Bun: above 256 KiB and far below 1 GiB, whatever the unit was.
      expect(usage!.rssBytes).toBeGreaterThan(256 * 1024)
      expect(usage!.rssBytes).toBeLessThan(1024 ** 3)
    } finally {
      stop(child)
    }
  }, 30_000)

  it('has no entry for a root that is gone, and one for a live root beside it', async () => {
    const gone = Bun.spawn(['true'])
    await gone.exited
    const live = burner()
    try {
      const usage = await sampleTrees([gone.pid, live.pid])
      expect([usage.has(gone.pid), usage.has(live.pid)]).toEqual([false, true])
    } finally {
      stop(live)
    }
  })
})

it("reads ps's time column, macOS hundredths (either decimal point) and days included", () => {
  expect(['0:01.50', '0:01,50', '01:02:03', '2-00:00:01', '12:34', 'x', '1'].map(psTimeMs)).toEqual(
    [1_500, 1_500, 3_723_000, 172_801_000, 754_000, undefined, undefined],
  )
})

const RUN: RunContextRecord = {
  runId: 'r',
  vxVersion: '0.0.0',
  workspaceId: 'w',
  workspaceName: 'ws',
  command: 'vx run x',
  requestedTasks: ['x'],
  cachePolicy: '',
  concurrency: 1,
  flow: 'focused',
  commitSha: null,
  branch: null,
  defaultBranch: null,
  dirty: false,
  ci: false,
  ciProvider: null,
  host: 'h',
  os: 'linux',
  arch: 'x64',
  tags: {},
}

describe('the telemetry source samples a tracked task', () => {
  it('only when a sink wants task.sample: otherwise there is nothing to track with', () => {
    const plain = createTelemetrySource({ sinks: [{ onRecord: () => {} }], run: RUN })
    const wanting = createTelemetrySource({
      sinks: [{ wants: ['task.sample'], onRecord: () => {} }],
      run: RUN,
    })
    expect([plain.track === undefined, typeof wanting.track]).toEqual([true, 'function'])
  })

  it('each second until untracked, then never again', async () => {
    // The clock is ticked by hand: a 2.3 s wall sleep saw one sample, not
    // two, on a slow macOS runner. The period is asserted, the ticks driven.
    const clock: { ms: number[]; fire?: () => Promise<void>; stops: number } = { ms: [], stops: 0 }
    const records: TelemetryRecord[] = []
    const source = createTelemetrySource({
      sinks: [{ wants: ['task.sample'], onRecord: (r) => void records.push(r) }],
      run: RUN,
      every: (ms, fn) => {
        clock.ms.push(ms)
        clock.fire = fn
        return () => void clock.stops++
      },
    })
    const child = burner()
    try {
      const untrack = source.track!('p#t', child.pid)
      expect([clock.ms, records.length]).toEqual([[1_000], 0])
      await clock.fire!()
      // The second look comes once the tree has burned more, however slow the host.
      const first = (records[0] as Extract<TelemetryRecord, { kind: 'task.sample' }>).cpuMs
      while (((await sampleTrees([child.pid])).get(child.pid)?.cpuMs ?? 0) <= first) {
        await Bun.sleep(20)
      }
      await clock.fire!()
      expect([records.length, clock.stops]).toEqual([2, 0])
      untrack()
      expect(clock.stops).toBe(1)
      // A tick already due when the timer stopped delivers nothing.
      await clock.fire!()
      expect([clock.ms, records.length]).toEqual([[1_000], 2])
      const [a, b] = records as Extract<TelemetryRecord, { kind: 'task.sample' }>[]
      expect([a!.kind, a!.taskId, a!.runId]).toEqual(['task.sample', 'p#t', 'r'])
      // Cumulative CPU of a burning tree rises between looks.
      expect(b!.cpuMs).toBeGreaterThan(a!.cpuMs)
    } finally {
      stop(child)
    }
  }, 10_000)
})

it('a run hands each spawned task to the sampler, keyed by its id', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-sample-'))
  roots.push(root)
  await Bun.write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
  )
  await writeLocalWorkspace(root)
  await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
  await Bun.write(
    path.join(root, 'pkg-a/vx.config.mjs'),
    `export default { tasks: { burn: { exec: { command: 'sleep 1.6' } } } }`,
  )
  gitInitCommit(root)
  const records: TelemetryRecord[] = []
  const result = await run({
    cwd: root,
    projects: ['pkg-a'],
    tasks: ['burn'],
    handleSignals: false,
    telemetrySinks: [{ wants: ['task.sample'], onRecord: (r) => void records.push(r) }],
  })
  expect(result.ok).toBe(true)
  const samples = records.filter((r) => r.kind === 'task.sample')
  expect(samples.length).toBeGreaterThan(0)
  expect([...new Set(samples.map((r) => r.taskId))]).toEqual(['pkg-a#burn'])
}, 20_000)
