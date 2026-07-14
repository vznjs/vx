// The telemetry contract + source + host — the canonical, observe-only
// data-export path (docs/design/observability-architecture-2026-06.md).
// Unit tests pin the projection (RunEvent → TelemetryRecord), cacheSource
// derivation, crash isolation, the task.log opt-in, and the host's
// perf-critical "no sink → no bus subscription" invariant. An e2e test
// drives a real run() through a declared telemetry plugin.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { run } from '../src/index.js'
import { busLogger, createEventBus } from '../src/orchestrator/events.js'
import {
  createTelemetrySource,
  deriveCacheSource,
  subscribeTelemetry,
  TELEMETRY_SCHEMA_VERSION,
  type RunContextRecord,
  type RunSummaryRecord,
  type TelemetryRecord,
  type TelemetrySink,
  type VxPlugin,
} from '../src/orchestrator/index.js'

function mkNode(id: string, command?: string): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    taskName,
    config: command === undefined ? {} : { exec: { command } },
    requested: false,
  } as unknown as TaskNode
}

function mkOutcome(node: TaskNode, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return { node, status: 'success', exitCode: 0, durationMs: 10, ...over } as TaskOutcome
}

const RUN: RunContextRecord = {
  runId: 'run-1',
  vxVersion: '0.0.0',
  workspaceId: 'ws-test',
  workspaceName: 'fixture-ws',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR,lW,rR,rW',
  concurrency: 4,
  flow: 'focused',
  commitSha: 'abc123',
  branch: 'main',
  defaultBranch: 'main',
  dirty: false,
  ci: false,
  ciProvider: null,
  host: 'host',
  os: 'linux',
  arch: 'x64',
  tags: { env: 'test' },
}

/** A recording sink that captures everything it receives. */
function recorder(wants?: ReadonlyArray<TelemetryRecord['kind']>) {
  const records: TelemetryRecord[] = []
  const summaries: RunSummaryRecord[] = []
  let flushed = 0
  const sink: TelemetrySink = {
    name: 'rec',
    ...(wants ? { wants } : {}),
    onRecord: (r) => records.push(r),
    onRunSummary: (s) => summaries.push(s),
    flush: async () => {
      flushed++
    },
  }
  return { sink, records, summaries, flushed: () => flushed }
}

describe('deriveCacheSource', () => {
  it('maps every status to its cache source', () => {
    expect(deriveCacheSource('cache-hit')).toBe('local')
    expect(deriveCacheSource('cache-hit-remote')).toBe('remote')
    expect(deriveCacheSource('success')).toBe('miss')
    expect(deriveCacheSource('failed')).toBe('miss')
    expect(deriveCacheSource('skipped')).toBe('none')
    expect(deriveCacheSource('aborted')).toBe('none')
  })
})

describe('createTelemetrySource — projection', () => {
  it('projects run:start → run.start carrying the run context', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'run:start', info: { total: 7 } })
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.kind).toBe('run.start')
    if (r.kind === 'run.start') {
      expect(r.v).toBe(TELEMETRY_SCHEMA_VERSION)
      expect(r.total).toBe(7)
      expect(r.run.runId).toBe('run-1')
      expect(r.run.commitSha).toBe('abc123')
    }
  })

  it('projects task:start → task.start with command, runId, and project/task', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'task:start', node: mkNode('a#build', 'tsc') })
    const r = records[0]!
    expect(r.kind).toBe('task.start')
    if (r.kind === 'task.start') {
      expect(r.runId).toBe('run-1')
      expect(r.taskId).toBe('a#build')
      expect(r.project).toBe('a')
      expect(r.task).toBe('build')
      expect(r.command).toBe('tsc')
    }
  })

  it('projects task:complete → task.end with derived cacheSource + analytics', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    const node = mkNode('a#build', 'tsc')
    src.subscriber({
      kind: 'task:complete',
      node,
      outcome: mkOutcome(node, {
        status: 'cache-hit-remote',
        hash: 'deadbeef',
        cpuMs: 5,
        peakRssBytes: 1024,
        wallclockStartNs: 100n,
        wallclockEndNs: 200n,
      }),
    })
    const r = records[0]!
    expect(r.kind).toBe('task.end')
    if (r.kind === 'task.end') {
      expect(r.status).toBe('cache-hit-remote')
      expect(r.cacheSource).toBe('remote')
      expect(r.hash).toBe('deadbeef')
      expect(r.cpuMs).toBe(5)
      expect(r.peakRssBytes).toBe(1024)
      expect(r.wallclockStartNs).toBe('100')
      expect(r.wallclockEndNs).toBe('200')
    }
  })

  it('projects the --verify verdict onto task.end (absent without --verify)', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    const node = mkNode('a#build', 'tsc')
    // A run WITHOUT --verify: no verdict on the outcome → no verify field.
    src.subscriber({ kind: 'task:complete', node, outcome: mkOutcome(node) })
    // A --verify run that caught a non-hermetic task.
    src.subscriber({
      kind: 'task:complete',
      node,
      outcome: mkOutcome(node, {
        verify: { kind: 'nondeterministic', changed: ['dist/a.js'] },
      } as Partial<TaskOutcome>),
    })
    const plain = records[0]!
    const verified = records[1]!
    if (plain.kind === 'task.end') expect(plain.verify).toBeUndefined()
    if (verified.kind === 'task.end') {
      expect(verified.verify).toEqual({ kind: 'nondeterministic', changed: ['dist/a.js'] })
    }
  })

  it('skips group tasks (no exec) for task.start and task.end', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    const group = mkNode('a#ci') // no command → group
    src.subscriber({ kind: 'task:start', node: group })
    src.subscriber({ kind: 'task:complete', node: group, outcome: mkOutcome(group) })
    expect(records).toHaveLength(0)
  })

  it('dedupes the double run:end into a single run.end record', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'run:end' })
    src.subscriber({ kind: 'run:end' })
    expect(records.filter((r) => r.kind === 'run.end')).toHaveLength(1)
  })

  it('does NOT project run:status (terminal noise, not telemetry)', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'run:status', line: 'some footer' })
    expect(records).toHaveLength(0)
  })
})

describe('createTelemetrySource — task.log opt-in', () => {
  it('does NOT emit task.log when no sink wants it', () => {
    const { sink, records } = recorder() // default wants excludes task.log
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'task:stdout', node: mkNode('a#build', 'x'), chunk: 'hello' })
    expect(records).toHaveLength(0)
  })

  it('emits task.log when a sink opts in via wants', () => {
    const { sink, records } = recorder(['task.log'])
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'task:stderr', node: mkNode('a#build', 'x'), chunk: 'warn!' })
    const r = records[0]!
    expect(r.kind).toBe('task.log')
    if (r.kind === 'task.log') {
      expect(r.stream).toBe('stderr')
      expect(r.chunk).toBe('warn!')
    }
  })

  it('a sink only receives the kinds it declares in wants', () => {
    const { sink, records } = recorder(['task.end'])
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'run:start', info: { total: 1 } })
    const node = mkNode('a#build', 'x')
    src.subscriber({ kind: 'task:start', node })
    src.subscriber({ kind: 'task:complete', node, outcome: mkOutcome(node) })
    expect(records.map((r) => r.kind)).toEqual(['task.end'])
  })
})

describe('createTelemetrySource — crash isolation', () => {
  it('disables a sink that throws and keeps delivering to the others', () => {
    const good = recorder()
    let badCalls = 0
    const bad: TelemetrySink = {
      name: 'bad',
      onRecord: () => {
        badCalls++
        throw new Error('boom')
      },
    }
    const src = createTelemetrySource({ sinks: [bad, good.sink], run: RUN })
    src.subscriber({ kind: 'run:start', info: { total: 1 } })
    src.subscriber({ kind: 'run:end' })
    // bad threw on the first record and was disabled (not called again).
    expect(badCalls).toBe(1)
    // good still got both records.
    expect(good.records.map((r) => r.kind)).toEqual(['run.start', 'run.end'])
  })

  it('emitSummary + flush are crash-isolated', async () => {
    const good = recorder()
    const bad: TelemetrySink = {
      name: 'bad',
      onRunSummary: () => {
        throw new Error('summary boom')
      },
      flush: async () => {
        throw new Error('flush boom')
      },
    }
    const src = createTelemetrySource({ sinks: [bad, good.sink], run: RUN })
    const summary: RunSummaryRecord = {
      v: TELEMETRY_SCHEMA_VERSION,
      run: RUN,
      startedAt: 0,
      endedAt: 1,
      totalDurationMs: 1,
      taskCount: 0,
      failedCount: 0,
      hitCount: 0,
      hitLocalCount: 0,
      hitRemoteCount: 0,
      exitOk: true,
      tasks: [],
    }
    expect(() => src.emitSummary(summary)).not.toThrow()
    await expect(src.flush()).resolves.toBeUndefined()
    expect(good.summaries).toHaveLength(1)
    expect(good.flushed()).toBe(1)
  })
})

describe('subscribeTelemetry — host', () => {
  const ctx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }

  it('returns undefined and subscribes NOTHING when no plugin contributes a sink', async () => {
    const bus = createEventBus()
    let delivered = 0
    bus.subscribe(() => delivered++)
    const before = delivered
    const handle = await subscribeTelemetry([], bus, ctx, RUN)
    expect(handle).toBeUndefined()
    // No telemetry subscriber was added (only our counter exists): emitting
    // increments by exactly 1 per event — the source did not subscribe.
    const log = busLogger(bus)
    log.runStart?.({ total: 1 })
    expect(delivered).toBe(before + 1)
  })

  it('returns undefined when a plugin declines (telemetry → undefined)', async () => {
    const bus = createEventBus()
    const plugins: VxPlugin[] = [{ name: 'org/decline', telemetry: () => undefined }]
    const handle = await subscribeTelemetry(plugins, bus, ctx, RUN)
    expect(handle).toBeUndefined()
  })

  it('subscribes the source and fans records when a sink is contributed', async () => {
    const bus = createEventBus()
    const rec = recorder()
    const plugins: VxPlugin[] = [{ name: 'org/tel', telemetry: () => rec.sink }]
    const handle = await subscribeTelemetry(plugins, bus, ctx, RUN)
    expect(handle).toBeDefined()
    const log = busLogger(bus)
    log.runStart?.({ total: 1 })
    log.runEnd?.()
    expect(rec.records.map((r) => r.kind)).toEqual(['run.start', 'run.end'])
    handle!.dispose()
  })

  it('accepts an array of sinks from one plugin', async () => {
    const bus = createEventBus()
    const a = recorder()
    const b = recorder()
    const plugins: VxPlugin[] = [{ name: 'org/tel', telemetry: () => [a.sink, b.sink] }]
    const handle = await subscribeTelemetry(plugins, bus, ctx, RUN)
    busLogger(bus).runStart?.({ total: 1 })
    expect(a.records).toHaveLength(1)
    expect(b.records).toHaveLength(1)
    handle!.dispose()
  })

  it('isolates a throwing telemetry FACTORY (warned, not thrown)', async () => {
    const bus = createEventBus()
    const warnings: string[] = []
    const plugins: VxPlugin[] = [
      {
        name: 'org/bad',
        telemetry: () => {
          throw new Error('factory boom')
        },
      },
    ]
    const handle = await subscribeTelemetry(
      plugins,
      bus,
      { ...ctx, warn: (m) => warnings.push(m) },
      RUN,
    )
    expect(handle).toBeUndefined()
    expect(warnings.some((w) => w.includes('org/bad'))).toBe(true)
  })

  it('dispose() removes the bus subscription (idempotent)', async () => {
    const bus = createEventBus()
    const rec = recorder()
    const plugins: VxPlugin[] = [{ name: 'org/tel', telemetry: () => rec.sink }]
    const handle = await subscribeTelemetry(plugins, bus, ctx, RUN)
    handle!.dispose()
    handle!.dispose() // idempotent — must not throw
    busLogger(bus).runStart?.({ total: 1 })
    expect(rec.records).toHaveLength(0)
  })
})

// --- end-to-end through run() via vx.workspace.mjs ---------------------

async function gitInit(dir: string): Promise<void> {
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
  await Bun.spawn(['git', 'add', '-A'], { cwd: dir }).exited
  await Bun.spawn(
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  ).exited
}

function makeSilentLogger() {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: () => undefined,
  }
}

describe('telemetry — end-to-end through run()', () => {
  it('a telemetry plugin receives streaming records AND the run summary', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'vx-telemetry-e2e-'))
    try {
      await Bun.write(
        path.join(workspaceRoot, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
      )
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/package.json'),
        JSON.stringify({ name: 'pkg-a' }),
      )
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `globalThis.__vxTel = { kinds: [], summary: null, summaryV: null }
         export default {
           plugins: [{
             name: 'org/tel',
             telemetry() {
               return {
                 onRecord: (r) => globalThis.__vxTel.kinds.push(r.kind),
                 onRunSummary: (s) => { globalThis.__vxTel.summary = s; globalThis.__vxTel.summaryV = s.v },
               }
             },
           }],
         }`,
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const tel = (
        globalThis as unknown as {
          __vxTel: { kinds: string[]; summary: RunSummaryRecord | null; summaryV: number | null }
        }
      ).__vxTel
      expect(tel.kinds).toContain('run.start')
      expect(tel.kinds).toContain('task.start')
      expect(tel.kinds).toContain('task.end')
      expect(tel.kinds).toContain('run.end')
      expect(tel.summary).not.toBeNull()
      expect(tel.summaryV).toBe(TELEMETRY_SCHEMA_VERSION)
      expect(tel.summary!.taskCount).toBe(1)
      expect(tel.summary!.exitOk).toBe(true)
      expect(tel.summary!.tasks[0]!.task).toBe('hello')
      expect(tel.summary!.run.commitSha).not.toBeNull()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('RunOptions.telemetrySinks attaches a sink without any plugin — the embedder seam', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'vx-telemetry-opt-'))
    try {
      await Bun.write(
        path.join(workspaceRoot, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
      )
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/package.json'),
        JSON.stringify({ name: 'pkg-a' }),
      )
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
      )
      // Deliberately NO vx.workspace.* — zero plugins; the option is the
      // only telemetry source (how the serve records delegated runs).
      await gitInit(workspaceRoot)
      let got: RunSummaryRecord | null = null
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
        handleSignals: false,
        telemetrySinks: [{ onRunSummary: (s) => (got = s) }],
      })
      expect(summary.ok).toBe(true)
      expect(got).not.toBeNull()
      const rec = got as unknown as RunSummaryRecord
      expect(rec.v).toBe(TELEMETRY_SCHEMA_VERSION)
      // v2: workspace identity present (this fixture has no remote, so it
      // comes from the persisted .vx/workspace-id salt).
      expect(rec.run.workspaceId).toMatch(/^[0-9a-f]{16}$/)
      expect(rec.run.workspaceName.length).toBeGreaterThan(0)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
