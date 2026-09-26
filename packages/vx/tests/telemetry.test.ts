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
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { run } from '../src/index.js'
import { busLogger, createEventBus } from '../src/orchestrator/events.js'
import {
  assembleRunSummary,
  createTelemetrySource,
  deriveCacheSource,
  subscribeTelemetry,
  TELEMETRY_SCHEMA_VERSION,
  type RunContextRecord,
  type RunEvent,
  type RunSummaryRecord,
  type TaskTelemetry,
  type TelemetryRecord,
  type TelemetrySink,
  type VxPlugin,
} from '../src/orchestrator/index.js'
import { pluginSource, testPlugin } from './helpers/plugin.js'

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

function tel(taskId: string, over: Partial<TaskTelemetry> = {}): TaskTelemetry {
  const [project, task] = taskId.split('#') as [string, string]
  return {
    taskId,
    project,
    task,
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1,
    ...over,
  }
}

describe('assembleRunSummary — the tallies a local and a distributed run share', () => {
  // THE one place the RunSummaryRecord tallies are computed: run() calls it
  // and so does the distributed controller, which is the whole point — the
  // two produce byte-identical summaries and land in the same ingest. It was
  // reached only through an end-to-end run(), whose fixture has no failure,
  // no remote hit and no aborted task, so five of the six tallies could be
  // wrong with every suite green.
  const timing = {
    startedAt: 1_000,
    endedAt: 5_000,
    totalDurationMs: 250,
    exitOk: true,
    abortedCount: 0,
  }

  it('counts only `failed` as a failure — an aborted task is not one', () => {
    const summary = assembleRunSummary(
      RUN,
      [
        tel('a#build', { status: 'failed', exitCode: 1 }),
        tel('b#build', { status: 'aborted', cacheSource: 'none' }),
        tel('c#build'),
      ],
      timing,
    )
    expect(summary.failedCount).toBe(1)
    expect(summary.taskCount).toBe(3)
  })

  it('tallies local and remote hits apart, and hitCount is their sum', () => {
    const summary = assembleRunSummary(
      RUN,
      [
        tel('a#build', { status: 'cache-hit', cacheSource: 'local' }),
        tel('b#build', { status: 'cache-hit-remote', cacheSource: 'remote' }),
        tel('c#build', { status: 'cache-hit-remote', cacheSource: 'remote' }),
        tel('d#build'),
        tel('e#build', { status: 'skipped', cacheSource: 'none' }),
      ],
      timing,
    )
    expect(summary.hitLocalCount).toBe(1)
    expect(summary.hitRemoteCount).toBe(2)
    expect(summary.hitCount).toBe(3)
  })

  it('takes `exitOk` from the run, never from the task list', () => {
    // The run's verdict counts skipped tasks BEYOND the recorded list, so a
    // summary whose every recorded task passed can still belong to a failed
    // run. Deriving exitOk from failedCount reports that run green.
    const summary = assembleRunSummary(RUN, [tel('a#build')], { ...timing, exitOk: false })
    expect(summary.failedCount).toBe(0)
    expect(summary.exitOk).toBe(false)
  })

  it('takes `totalDurationMs` from the run, not from endedAt − startedAt', () => {
    // run() passes a MONOTONIC hrtime measure; startedAt/endedAt are
    // Date.now() epoch stamps taken at different points. Recomputing the
    // duration from them swaps a monotonic number for a settable one.
    const summary = assembleRunSummary(RUN, [tel('a#build')], timing)
    expect(summary.totalDurationMs).toBe(250)
    expect(summary.endedAt - summary.startedAt).toBe(4_000)
  })
})

describe('createTelemetrySource — a disabled sink', () => {
  it('says so, and is skipped for the REST of the run including flush', async () => {
    // The doc comment promises a throwing sink is "disabled for the rest of
    // the run" and "skipped for the rest of the run". `onRecord` and
    // `onRunSummary` honour that; `flush` did not consult the set at all, so
    // a sink whose state was bad enough to throw was still asked to write its
    // output — from a buffer that is INCOMPLETE by construction, since it
    // stopped being fed records the moment it was disabled.
    //
    // And the disable was SILENT, against the standing invariant that a
    // never-fail path must still WARN. Telemetry vanished with no signal.
    const warns: string[] = []
    let badFlushed = 0
    let goodFlushed = 0
    const bad: TelemetrySink = {
      name: 'bad-sink',
      onRecord: () => {
        throw new Error('boom')
      },
      flush: async () => {
        badFlushed++
      },
    }
    const good: TelemetrySink = {
      name: 'good-sink',
      onRecord: () => undefined,
      flush: async () => {
        goodFlushed++
      },
    }
    const src = createTelemetrySource({
      sinks: [bad, good],
      run: RUN,
      warn: (m) => warns.push(m),
    })
    src.subscriber({ kind: 'run:start', info: { total: 1 } })
    await src.flush()

    expect(warns.some((w) => w.includes('bad-sink'))).toBe(true)
    expect(badFlushed).toBe(0)
    // CONTROL: disabling one sink must not cost the others their flush.
    expect(goodFlushed).toBe(1)
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

  it('task.end carries every fact it copies, each under its own name', () => {
    // A `--download=none` task's deferred `outputs` had no reader on the
    // streaming record, so dropping its copy left the suite green (654).
    // The whole record is compared, bar the projection clock.
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    const node = mkNode('a#build', 'tsc')
    src.subscriber({
      kind: 'task:complete',
      node,
      outcome: mkOutcome(node, {
        status: 'success',
        exitCode: 0,
        durationMs: 12,
        hash: 'h',
        cpuMs: 5,
        peakRssBytes: 2048,
        where: 'worker-3',
        outputs: 'deferred',
        attempts: 2,
        wallclockStartNs: 100n,
        wallclockEndNs: 200n,
      }),
    })
    const { ts, ...rest } = records[0] as TelemetryRecord & { ts: number }
    expect(typeof ts).toBe('number')
    expect(rest).toEqual({
      v: TELEMETRY_SCHEMA_VERSION,
      kind: 'task.end',
      runId: 'run-1',
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 12,
      hash: 'h',
      cpuMs: 5,
      peakRssBytes: 2048,
      where: 'worker-3',
      outputs: 'deferred',
      attempts: 2,
      wallclockStartNs: '100',
      wallclockEndNs: '200',
    })
  })

  it("stamps run.start with the RUN's start, not the projection's clock", () => {
    // `startedAt` equals the summary's startedAt on purpose — a sink derives
    // per-task timing from it DURING the run, before any summary exists. `ts`
    // is when this record was projected, which is later and drifts per event.
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'run:start', info: { total: 1, startedAtMs: 1_600_000_000_000 } })
    const r = records[0]!
    if (r.kind === 'run.start') {
      expect(r.startedAt).toBe(1_600_000_000_000)
      expect(r.startedAt).not.toBe(r.ts)
    }

    // CONTROL: an event that does not carry one falls back to the projection
    // clock, so the field is never absent.
    const later = recorder()
    createTelemetrySource({ sinks: [later.sink], run: RUN }).subscriber({
      kind: 'run:start',
      info: { total: 1 },
    })
    const f = later.records[0]!
    if (f.kind === 'run.start') expect(f.startedAt).toBe(f.ts)
  })

  it('carries `attempts` — the telemetry-side flaky signal — only when it retried', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    const node = mkNode('a#build', 'tsc')
    src.subscriber({ kind: 'task:complete', node, outcome: mkOutcome(node, { attempts: 3 }) })
    // CONTROL: a task that ran once says nothing, so a reader can treat the
    // field's presence as the signal.
    src.subscriber({ kind: 'task:complete', node, outcome: mkOutcome(node) })
    expect(records.map((r) => (r.kind === 'task.end' ? r.attempts : 'not-task-end'))).toEqual([
      3,
      undefined,
    ])
  })

  // Item 654 found it, item 660 fixed it: task.end had its own copy of the
  // projection and dropped these four, so a streaming sink (otel) saw a
  // timed-out, sandbox-violating or never-ready failure as a plain `failed`
  // and a blocked skip with no blocker. Both now call `taskTelemetryOf`.
  it('task.end carries the failure and skip reasons the summary row carries', () => {
    const { sink, records } = recorder()
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    const node = mkNode('a#build', 'tsc')
    src.subscriber({
      kind: 'task:complete',
      node,
      outcome: mkOutcome(node, {
        status: 'failed',
        exitCode: 143,
        timedOut: true,
        sandboxViolations: 2,
        notReady: 'timeout',
      }),
    })
    const skipped = mkNode('b#build', 'tsc')
    src.subscriber({
      kind: 'task:complete',
      node: skipped,
      outcome: mkOutcome(skipped, { status: 'skipped', blockedBy: 'a#build' }),
    })
    expect(
      records.map((r) =>
        r.kind === 'task.end'
          ? [r.timedOut, r.sandboxViolations, r.notReady, r.blockedBy]
          : 'not-task-end',
      ),
    ).toEqual([
      [true, 2, 'timeout', undefined],
      [undefined, undefined, undefined, 'a#build'],
    ])
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

  it('checks the opt-in BEFORE projecting, so a declined chunk is never read', () => {
    // "The source checks this before projecting/cloning, so a sink pays
    // nothing for kinds it declines." The row above it asserts only that no
    // RECORD arrives — and deliver()'s own kind filter answers that whether
    // or not the gate exists, so both the gate and the `wants` scan behind
    // it could go with the suite green. What the gate actually buys is that
    // the chunk is never touched: a getter counts the reads.
    let chunkReads = 0
    const event = { kind: 'task:stdout' as const, node: mkNode('a#build', 'x') }
    Object.defineProperty(event, 'chunk', {
      enumerable: true,
      get: () => {
        chunkReads++
        return 'payload'
      },
    })

    const declines = recorder() // default wants excludes task.log
    createTelemetrySource({ sinks: [declines.sink], run: RUN }).subscriber(event as RunEvent)
    expect(chunkReads).toBe(0)
    expect(declines.records).toHaveLength(0)

    // CONTROL: the same event past a sink that opts in reads the chunk once
    // and carries it through, so the count is measuring the projection.
    const wants = recorder(['task.log'])
    createTelemetrySource({ sinks: [wants.sink], run: RUN }).subscriber(event as RunEvent)
    expect(chunkReads).toBe(1)
    const r = wants.records[0]!
    expect(r.kind).toBe('task.log')
    if (r.kind === 'task.log') expect(r.chunk).toBe('payload')
  })

  it('labels a stdout chunk `stdout` — the stream the reader routes on', () => {
    const { sink, records } = recorder(['task.log'])
    const src = createTelemetrySource({ sinks: [sink], run: RUN })
    src.subscriber({ kind: 'task:stdout', node: mkNode('a#build', 'x'), chunk: 'out!' })
    src.subscriber({ kind: 'task:stderr', node: mkNode('a#build', 'x'), chunk: 'err!' })
    expect(records.map((r) => (r.kind === 'task.log' ? r.stream : r.kind))).toEqual([
      'stdout',
      'stderr',
    ])
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

  it('a sink on the defaults gets no task.log while another sink opted in', () => {
    // Alone, a default sink is shielded by the `wantsLog` gate: no chunk is
    // projected at all. Only beside an opted-in sink does the default kind
    // list decide, and a default that held `task.log` passed every row (654).
    const logs = recorder(['task.log'])
    const plain = recorder()
    const src = createTelemetrySource({ sinks: [logs.sink, plain.sink], run: RUN })
    const node = mkNode('a#build', 'x')
    src.subscriber({ kind: 'task:start', node })
    src.subscriber({ kind: 'task:stdout', node, chunk: 'hi' })
    expect(logs.records.map((r) => r.kind)).toEqual(['task.log'])
    expect(plain.records.map((r) => r.kind)).toEqual(['task.start'])
  })
})

const SUMMARY: RunSummaryRecord = {
  v: TELEMETRY_SCHEMA_VERSION,
  run: RUN,
  startedAt: 0,
  endedAt: 1,
  totalDurationMs: 1,
  taskCount: 0,
  failedCount: 0,
  abortedCount: 0,
  hitCount: 0,
  hitLocalCount: 0,
  hitRemoteCount: 0,
  exitOk: true,
  tasks: [],
}

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

  it('a sink disabled mid-run gets no run summary either', () => {
    // "disabled for the rest of the run, FLUSH INCLUDED" — and the summary is
    // the record that matters most, since an ingest persists a whole run from
    // it. A sink that stopped being fed records the moment it threw would
    // otherwise hand over a summary built from an incomplete buffer.
    let badSummaries = 0
    const bad: TelemetrySink = {
      name: 'bad',
      onRecord: () => {
        throw new Error('boom')
      },
      onRunSummary: () => {
        badSummaries++
      },
    }
    const good = recorder()
    const src = createTelemetrySource({ sinks: [bad, good.sink], run: RUN })
    src.subscriber({ kind: 'run:start', info: { total: 1 } })
    src.emitSummary(SUMMARY)
    expect(badSummaries).toBe(0)
    // CONTROL: a sink that never threw still gets it.
    expect(good.summaries).toHaveLength(1)
  })

  it('reports a sink whose flush rejects, and still resolves', async () => {
    // No fixture reached this path: the only sink whose flush threw had been
    // disabled one line earlier by a throwing onRunSummary, so flush returned
    // before ever calling it. A rejection here propagates through
    // Promise.all into settleWithin and out of flush() — which run() awaits
    // before closeCache(), so the cache never closes and the exit code is
    // lost. And dropping it silently is the thing the standing rule forbids:
    // this sink's whole export is gone.
    const warns: string[] = []
    const src = createTelemetrySource({
      sinks: [
        {
          name: 'flaky-sink',
          flush: async () => {
            throw new Error('disk full')
          },
        },
      ],
      run: RUN,
      warn: (m) => warns.push(m),
    })
    await expect(src.flush()).resolves.toBeUndefined()
    expect(warns).toEqual(["[vx] telemetry sink 'flaky-sink' failed to flush: disk full"])
  })

  it('a sink with no flush hook is not asked to flush, and nothing is said', async () => {
    // `flush` is optional. Calling it anyway throws a TypeError the flush
    // catch reports as "failed to flush" — a warning on every run for a
    // sink that buffers nothing (654).
    const warns: string[] = []
    const src = createTelemetrySource({
      sinks: [{ name: 'stream-only', onRecord: () => undefined }],
      run: RUN,
      warn: (m) => warns.push(m),
    })
    await src.flush()
    expect(warns).toEqual([])
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
    expect(() => src.emitSummary(SUMMARY)).not.toThrow()
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
    const plugins: VxPlugin[] = [testPlugin('org/decline', { telemetry: () => undefined })]
    const warnings: string[] = []
    const handle = await subscribeTelemetry(
      plugins,
      bus,
      { ...ctx, warn: (m) => warnings.push(m) },
      RUN,
    )
    expect(handle).toBeUndefined()
    // Declining is a plugin's normal answer (otel() with no endpoint), not a
    // fault: read as a one-sink list, `undefined` was refused as "must be an
    // object" and every declined run warned (654).
    expect(warnings).toEqual([])
  })

  it('subscribes the source and fans records when a sink is contributed', async () => {
    const bus = createEventBus()
    const rec = recorder()
    const plugins: VxPlugin[] = [testPlugin('org/tel', { telemetry: () => rec.sink })]
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
    const plugins: VxPlugin[] = [testPlugin('org/tel', { telemetry: () => [a.sink, b.sink] })]
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
      testPlugin('org/bad', {
        telemetry: () => {
          throw new Error('factory boom')
        },
      }),
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

  it('passes over a plugin with no telemetry hook without a word', async () => {
    // Calling the missing hook throws a TypeError, which the consultation's
    // catch turned into "telemetry failed to initialize" for every plugin
    // that never offered telemetry — a warning on every run of a workspace
    // with a cache or executor plugin (654).
    const warnings: string[] = []
    const handle = await subscribeTelemetry(
      [testPlugin('org/cache-only', {})],
      createEventBus(),
      { ...ctx, warn: (m) => warnings.push(m) },
      RUN,
    )
    expect(handle).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('refuses a sink that is not an object, or whose wants is not an array, by name', async () => {
    // Without the shape checks a `null` sink is still refused — by the raw
    // TypeError of reading `.wants` off it — and a number is refused as
    // "handles nothing"; only the words change, so the row pins the words.
    // A string `wants` is worse: `'run.start'.includes(kind)` is a
    // SUBSTRING match, so it was accepted and filtered by accident (654).
    const bad = (name: string, result: unknown): VxPlugin =>
      testPlugin(name, { telemetry: () => result as TelemetrySink })
    const warnings: string[] = []
    const handle = await subscribeTelemetry(
      [
        bad('org/null', null),
        bad('org/number', 42),
        bad('org/wants', { wants: 'run.start', onRecord: () => undefined }),
      ],
      createEventBus(),
      { ...ctx, warn: (m) => warnings.push(m) },
      RUN,
    )
    expect(handle).toBeUndefined()
    const why = (name: string, msg: string) =>
      `[vx] plugin '${name}' telemetry failed to initialize; disabled for this run: ${msg}`
    expect(warnings).toEqual([
      why('org/null', 'telemetry sink must be an object, got null'),
      why('org/number', 'telemetry sink must be an object, got number'),
      why('org/wants', "telemetry sink 'wants' must be an array, got string"),
    ])
  })

  it('dispose() removes the bus subscription (idempotent)', async () => {
    const bus = createEventBus()
    const rec = recorder()
    const plugins: VxPlugin[] = [testPlugin('org/tel', { telemetry: () => rec.sink })]
    const handle = await subscribeTelemetry(plugins, bus, ctx, RUN)
    // Subscribed AFTER the sink, so a second dispose that reached the bus
    // with the sink already gone would splice(-1, 1) this one away. The
    // handle's `disposed` flag and the bus disposer's found-guard each
    // prevent it alone; this row holds the pair (654).
    const renderer: string[] = []
    bus.subscribe((e) => renderer.push(e.kind))
    handle!.dispose()
    handle!.dispose() // idempotent — must not throw
    busLogger(bus).runStart?.({ total: 1 })
    expect(rec.records).toHaveLength(0)
    expect(renderer).toEqual(['run:start'])
  })
})

// --- end-to-end through run() via vx.workspace.mjs ---------------------

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
        localWorkspaceSource(
          [
            pluginSource(
              'org/tel',
              `{ telemetry() {
               return {
                 onRecord: (r) => globalThis.__vxTel.kinds.push(r.kind),
                 onRunSummary: (s) => { globalThis.__vxTel.summary = s; globalThis.__vxTel.summaryV = s.v },
               }
             },
           }`,
            ),
          ],
          `globalThis.__vxTel = { kinds: [], summary: null, summaryV: null }
`,
        ),
      )
      gitInitCommit(workspaceRoot)
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
      // Deliberately no telemetry plugin — only the local executor + cache;
      // the option is the only telemetry source (how the serve records
      // delegated runs).
      await writeLocalWorkspace(workspaceRoot)
      gitInitCommit(workspaceRoot)
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
