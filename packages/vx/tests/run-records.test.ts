// What a finished run leaves behind, field by field: `assembleRunRecords`
// over hand-built outcomes, so each row, header column and count is held by
// exact value. The run()-level suites cover the columns a reader shows; the
// sweep of `run-records.ts` (C-47) found 27 fields and arms they never
// looked at — the timeline anchors, the host/git/ci header, the remote hit
// count among them.

import { describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { assembleRunRecords, type RunRecordsInput } from '../src/orchestrator/run-records.js'
import { formatRunSummary } from '../src/orchestrator/summary.js'
import { VERSION } from '../src/version.js'

const EXEC = { exec: { command: 'noop' } }

function outcome(
  id: string,
  status: TaskOutcome['status'],
  extra: Partial<TaskOutcome> = {},
  config: object = EXEC,
): TaskOutcome {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    node: { id, projectName, taskName, config } as TaskNode,
    status,
    exitCode: 0,
    durationMs: 100,
    ...extra,
  }
}

function input(outcomes: TaskOutcome[], over: Partial<RunRecordsInput> = {}): RunRecordsInput {
  return {
    outcomes,
    runId: 'run-1',
    startedAtMs: 1_000_000,
    endedAtMs: 1_005_000,
    totalMs: 5000.4,
    ok: false,
    command: 'vx run build',
    requestedTasks: ['build'],
    cachePolicy: 'rw',
    concurrency: 3,
    flow: 'focused',
    tags: { team: 'core' },
    git: { commitSha: 'abc123', branch: 'main', dirty: true },
    ci: { ci: true, provider: 'github' },
    host: { host: 'box', os: 'linux', arch: 'x64' },
    withTelemetry: true,
    ...over,
  }
}

describe('assembleRunRecords', () => {
  it('anchors a timed row to the run start and an untimed one to the run end', () => {
    const { runs } = assembleRunRecords(
      input([
        outcome('a#build', 'success', {
          hash: 'h1',
          wallclockStartNs: 1_500_400_000n,
          wallclockEndNs: 2_600_600_000n,
          attempts: 2,
          sandboxViolations: 3,
        }),
        outcome('b#build', 'skipped', { durationMs: 250, blockedBy: 'a#build' }),
      ]),
    )
    expect(runs).toStrictEqual([
      {
        hash: 'h1',
        project: 'a',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: 100,
        startedAt: 1_001_500,
        endedAt: 1_002_601,
        runId: 'run-1',
        wallclockStartNs: 1_500_400_000n,
        wallclockEndNs: 2_600_600_000n,
        cacheHit: false,
        attempts: 2,
        cached: false,
        sandboxViolations: 3,
      },
      {
        project: 'b',
        task: 'build',
        status: 'skipped',
        exitCode: 0,
        durationMs: 250,
        startedAt: 1_004_750,
        endedAt: 1_005_000,
        runId: 'run-1',
        cacheHit: false,
        cached: false,
        blockedBy: 'a#build',
      },
    ])
  })

  it('stamps forwarded args on every row, and none when there were none', () => {
    const outcomes = [outcome('a#test', 'success'), outcome('b#test', 'failed')]
    const withArgs = assembleRunRecords(input(outcomes, { forwardArgs: ['--watch'] }))
    expect(withArgs.runs.map((r) => r.forwardArgs)).toStrictEqual([['--watch'], ['--watch']])
    const without = assembleRunRecords(input(outcomes))
    expect(without.runs.map((r) => 'forwardArgs' in r)).toStrictEqual([false, false])
  })

  it('writes the header row from the run, its context and its counts', () => {
    const { invocation } = assembleRunRecords(
      input([
        outcome('a#build', 'cache-hit', { restored: true }),
        outcome('b#build', 'cache-hit-remote'),
        outcome('c#build', 'cache-hit-remote', { restored: true }),
        outcome('d#build', 'failed', { exitCode: 1 }),
        outcome('e#build', 'success'),
      ]),
    )
    expect(invocation).toStrictEqual({
      runId: 'run-1',
      command: 'vx run build',
      requestedTasks: '["build"]',
      cachePolicy: 'rw',
      concurrency: 3,
      flow: 'focused',
      startedAt: 1_000_000,
      endedAt: 1_005_000,
      totalDurationMs: 5000,
      taskCount: 5,
      failedCount: 1,
      hitCount: 3,
      hitLocalCount: 1,
      hitRemoteCount: 2,
      exitOk: false,
      commitSha: 'abc123',
      branch: 'main',
      dirty: true,
      ci: true,
      ciProvider: 'github',
      host: 'box',
      os: 'linux',
      arch: 'x64',
      vxVersion: VERSION,
      tags: '{"team":"core"}',
    })
  })

  it('builds the telemetry mirror only when a sink is active', () => {
    const outcomes = [outcome('a#build', 'success'), outcome('b#build', 'cache-hit')]
    const on = assembleRunRecords(input(outcomes))
    expect(on.telemetryTasks.map((t) => t.taskId)).toStrictEqual(['a#build', 'b#build'])
    const off = assembleRunRecords(input(outcomes, { withTelemetry: false }))
    expect(off.telemetryTasks).toStrictEqual([])
    expect(off.runs.length).toBe(2)
  })

  // The header's task_count, the terminal's "N total" and the telemetry task
  // count are three copies of one filter (group and aborted outcomes out).
  // Every shape that could split them, in one run.
  it('counts the same tasks in the header, the terminal and telemetry', () => {
    const outcomes = [
      outcome('ws#all', 'success', {}, {}),
      outcome('a#build', 'cache-hit', { restored: true }),
      outcome('b#build', 'cache-hit', { restored: false }),
      outcome('c#build', 'cache-hit-remote', { restored: true }),
      outcome('d#build', 'aborted', { exitCode: 130 }),
      outcome('e#build', 'failed', { exitCode: 1 }),
      outcome('f#build', 'skipped', { blockedBy: 'e#build' }),
      outcome('g#build', 'success'),
    ]
    const { runs, invocation, telemetryTasks } = assembleRunRecords(input(outcomes))
    const counted = ['a#build', 'b#build', 'c#build', 'e#build', 'f#build', 'g#build']
    expect(runs.map((r) => `${r.project}#${r.task}`)).toStrictEqual(counted)
    expect(telemetryTasks.map((t) => t.taskId)).toStrictEqual(counted)
    expect(invocation.taskCount).toBe(6)
    const totals = formatRunSummary(outcomes, 10).filter((l) => l.includes(' total'))
    expect(totals).toStrictEqual(['            1 failed · 4 success · 1 skipped · 6 total'])
  })
})
