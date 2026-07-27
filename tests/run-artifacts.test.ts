// `--summarize` and `--profile` output artifacts.
//
// `run-artifacts.ts` is a pure pair of writers; we feed it synthetic
// outcomes and parse the resulting JSON to verify the shape contract
// each consumer (CI summaries, chrome://tracing) depends on.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeRunProfile, writeRunSummary } from '../src/orchestrator/run-artifacts.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function makeNode(
  project: string,
  taskName: string,
  opts: { exec?: { command: string } | undefined } = {},
): TaskNode {
  return {
    id: `${project}#${taskName}`,
    projectName: project,
    projectDir: `/tmp/${project}`,
    taskName,
    deps: [],
    requested: true,
    config: {
      ...(opts.exec === undefined ? {} : { exec: opts.exec }),
    },
  }
}

function execNode(project: string, taskName: string): TaskNode {
  return makeNode(project, taskName, { exec: { command: 'noop' } })
}

function groupNode(project: string, taskName: string): TaskNode {
  return makeNode(project, taskName, { exec: undefined })
}

describe('writeRunSummary', () => {
  let tmp: string
  let cacheDir: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-summary-'))
    cacheDir = path.join(tmp, '.vx', 'cache')
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const outcome = (overrides: Partial<TaskOutcome> & { node: TaskNode }): TaskOutcome => ({
    status: 'success',
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  })

  it('writes the default path `<cacheDir>/runs/<runId>.json` when target is ""', async () => {
    const out = await writeRunSummary({
      target: '',
      cacheDir,
      cwd: tmp,
      runId: '01ABCDEFG',
      startedAtMs: 1_700_000_000_000,
      endedAtMs: 1_700_000_005_000,
      totalMs: 5000,
      outcomes: [outcome({ node: execNode('pkg', 'build') })],
    })
    expect(out).toBe(path.join(cacheDir, 'runs', '01ABCDEFG.json'))
    const parsed = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>
    expect(parsed['runId']).toBe('01ABCDEFG')
  })

  it('resolves an explicit target path relative to cwd', async () => {
    const out = await writeRunSummary({
      target: 'reports/summary.json',
      cacheDir,
      cwd: tmp,
      runId: '01ABCDEFG',
      startedAtMs: 0,
      endedAtMs: 1,
      totalMs: 1,
      outcomes: [],
    })
    expect(out).toBe(path.join(tmp, 'reports', 'summary.json'))
    // File exists and parses.
    JSON.parse(await readFile(out, 'utf8'))
  })

  it('uses an absolute target as-is', async () => {
    const absolute = path.join(tmp, 'absolute.json')
    const out = await writeRunSummary({
      target: absolute,
      cacheDir,
      cwd: '/never/used',
      runId: '01ABCDEFG',
      startedAtMs: 0,
      endedAtMs: 1,
      totalMs: 1,
      outcomes: [],
    })
    expect(out).toBe(absolute)
  })

  it('emits ISO 8601 timestamps for startedAt / endedAt', async () => {
    const out = await writeRunSummary({
      target: path.join(tmp, 's.json'),
      cacheDir,
      cwd: tmp,
      runId: '01ABCDEFG',
      startedAtMs: 1_700_000_000_000,
      endedAtMs: 1_700_000_005_000,
      totalMs: 5000,
      outcomes: [],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as Record<string, string>
    expect(parsed['startedAt']).toBe('2023-11-14T22:13:20.000Z')
    expect(parsed['endedAt']).toBe('2023-11-14T22:13:25.000Z')
  })

  it('serializes hrtime bigints as decimal strings (preserves ns precision)', async () => {
    // JSON has no native bigint; numbers above 2^53 lose precision.
    // The writer must emit hrtime fields as strings.
    const o = outcome({
      node: execNode('pkg', 'build'),
      wallclockStartNs: 12_345_678_901_234n,
      wallclockEndNs: 12_345_679_001_234n,
    })
    const out = await writeRunSummary({
      target: path.join(tmp, 's.json'),
      cacheDir,
      cwd: tmp,
      runId: 'x',
      startedAtMs: 0,
      endedAtMs: 1,
      totalMs: 1,
      outcomes: [o],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      tasks: Array<{ wallclockStartNs: unknown; wallclockEndNs: unknown }>
    }
    expect(parsed.tasks[0]?.wallclockStartNs).toBe('12345678901234')
    expect(parsed.tasks[0]?.wallclockEndNs).toBe('12345679001234')
  })

  it('includes optional cpuMs / peakRssBytes when set; omits when undefined', async () => {
    const out = await writeRunSummary({
      target: path.join(tmp, 's.json'),
      cacheDir,
      cwd: tmp,
      runId: 'x',
      startedAtMs: 0,
      endedAtMs: 1,
      totalMs: 1,
      outcomes: [
        outcome({ node: execNode('a', 'build'), cpuMs: 123, peakRssBytes: 45678 }),
        outcome({ node: execNode('b', 'lint') }),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(parsed.tasks[0]?.['cpuMs']).toBe(123)
    expect(parsed.tasks[0]?.['peakRssBytes']).toBe(45678)
    expect(parsed.tasks[1]?.['cpuMs']).toBeUndefined()
    expect(parsed.tasks[1]?.['peakRssBytes']).toBeUndefined()
  })

  it("emits `hash: null` when an outcome's hash is missing", async () => {
    const out = await writeRunSummary({
      target: path.join(tmp, 's.json'),
      cacheDir,
      cwd: tmp,
      runId: 'x',
      startedAtMs: 0,
      endedAtMs: 1,
      totalMs: 1,
      outcomes: [outcome({ node: execNode('pkg', 'lint') })],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(parsed.tasks[0]?.['hash']).toBeNull()
  })

  it('summary block counts only exec tasks (group tasks excluded from totals)', async () => {
    // `tasks[]` and `summary` describe the SAME population. Listing a group
    // task while excluding it from `summary.total` made one artifact
    // contradict itself (3 entries, total 2); `tallyOutcomes` owns the rule
    // and both halves follow it.
    const out = await writeRunSummary({
      target: path.join(tmp, 's.json'),
      cacheDir,
      cwd: tmp,
      runId: 'x',
      startedAtMs: 0,
      endedAtMs: 1,
      totalMs: 1,
      outcomes: [
        outcome({ node: groupNode('pkg', 'ci') }),
        outcome({ node: execNode('pkg', 'lint'), status: 'success' }),
        outcome({ node: execNode('pkg', 'test'), status: 'cache-hit' }),
        outcome({ node: execNode('pkg', 'broken'), status: 'failed', exitCode: 1 }),
        outcome({ node: execNode('pkg', 'unreachable'), status: 'skipped' }),
        outcome({ node: execNode('pkg', 'remote'), status: 'cache-hit-remote' }),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      tasks: Array<{ id: string }>
      summary: Record<string, number>
    }
    // The group entry is excluded from BOTH halves, which therefore agree.
    expect(parsed.tasks.map((t) => t.id)).not.toContain('pkg#ci')
    expect(parsed.tasks.length).toBe(parsed.summary['total']!)
    expect(parsed.summary['total']).toBe(5)
    expect(parsed.summary['successful']).toBe(3) // success + cache-hit + cache-hit-remote
    expect(parsed.summary['failed']).toBe(1)
    expect(parsed.summary['skipped']).toBe(1)
    expect(parsed.summary['cachedLocal']).toBe(1)
    expect(parsed.summary['cachedRemote']).toBe(1)
  })
})

describe('writeRunProfile', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-profile-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const outcome = (overrides: Partial<TaskOutcome> & { node: TaskNode }): TaskOutcome => ({
    status: 'success',
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  })

  it('emits a Chrome-trace JSON shape with one complete event per task', async () => {
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [
        outcome({
          node: execNode('app', 'build'),
          wallclockStartNs: 100_000n,
          wallclockEndNs: 200_000n,
          hash: 'h1',
        }),
      ],
    })
    expect(out).toBe(path.join(tmp, 'profile.json'))
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      traceEvents: Array<Record<string, unknown>>
    }
    expect(parsed.traceEvents).toHaveLength(1)
    const ev = parsed.traceEvents[0]!
    expect(ev['name']).toBe('app#build')
    expect(ev['ph']).toBe('X')
    expect(ev['cat']).toBe('success')
    expect(ev['pid']).toBe(1)
    expect(typeof ev['tid']).toBe('number')
    expect(ev['ts']).toBe(100) // 100_000 ns / 1000 = 100 us
    expect(ev['dur']).toBe(100) // (200_000 - 100_000) / 1000 = 100 us
  })

  it('assigns a distinct tid per project (so parallel tasks land on separate lanes)', async () => {
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [
        outcome({
          node: execNode('a', 'build'),
          wallclockStartNs: 0n,
          wallclockEndNs: 1_000n,
        }),
        outcome({
          node: execNode('a', 'test'),
          wallclockStartNs: 1_000n,
          wallclockEndNs: 2_000n,
        }),
        outcome({
          node: execNode('b', 'build'),
          wallclockStartNs: 0n,
          wallclockEndNs: 1_000n,
        }),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      traceEvents: Array<{ name: string; tid: number }>
    }
    const byName = Object.fromEntries(parsed.traceEvents.map((e) => [e.name, e.tid]))
    // Both tasks in `a` share a lane.
    expect(byName['a#build']).toBe(byName['a#test'])
    // `b` gets its own.
    expect(byName['b#build']).not.toBe(byName['a#build'])
  })

  it('omits tasks without hrtime spans (group tasks, legacy outcomes)', async () => {
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [
        // No hrtime → excluded.
        outcome({ node: groupNode('pkg', 'ci') }),
        outcome({
          node: execNode('pkg', 'build'),
          wallclockStartNs: 0n,
          wallclockEndNs: 1_000n,
        }),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      traceEvents: Array<{ name: string }>
    }
    expect(parsed.traceEvents.map((e) => e.name)).toEqual(['pkg#build'])
  })

  it('includes cpuMs / peakRssBytes / hash inside the args object when available', async () => {
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [
        outcome({
          node: execNode('pkg', 'build'),
          wallclockStartNs: 0n,
          wallclockEndNs: 1_000n,
          cpuMs: 50,
          peakRssBytes: 1_000_000,
          hash: 'abc',
        }),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      traceEvents: Array<{ args: Record<string, unknown> }>
    }
    expect(parsed.traceEvents[0]!.args).toMatchObject({
      exitCode: 0,
      hash: 'abc',
      cpuMs: 50,
      peakRssBytes: 1_000_000,
    })
  })

  it('cat field reflects every outcome status verbatim', async () => {
    const make = (status: TaskOutcome['status']): TaskOutcome =>
      outcome({
        node: execNode('pkg', `t-${status}`),
        status,
        wallclockStartNs: 0n,
        wallclockEndNs: 1_000n,
      })
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [
        make('success'),
        make('failed'),
        make('cache-hit'),
        make('cache-hit-remote'),
        make('skipped'),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      traceEvents: Array<{ name: string; cat: string }>
    }
    const cats = Object.fromEntries(parsed.traceEvents.map((e) => [e.name, e.cat]))
    expect(cats['pkg#t-success']).toBe('success')
    expect(cats['pkg#t-failed']).toBe('failed')
    expect(cats['pkg#t-cache-hit']).toBe('cache-hit')
    expect(cats['pkg#t-cache-hit-remote']).toBe('cache-hit-remote')
    expect(cats['pkg#t-skipped']).toBe('skipped')
  })

  it('produces JSON without bigint leak (round-trips through JSON.parse)', async () => {
    // If the writer leaked a raw bigint into the JSON stringification,
    // either the serialize would throw OR a number > 2^53 would lose
    // precision silently. Pin: very-large hrtime values survive.
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [
        outcome({
          node: execNode('pkg', 'build'),
          wallclockStartNs: 9_007_199_254_741_000n, // > 2^53
          wallclockEndNs: 9_007_199_254_742_000n,
        }),
      ],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      traceEvents: Array<{ ts: number; dur: number }>
    }
    expect(parsed.traceEvents[0]!.dur).toBe(1) // (1000ns / 1000) = 1us
    // ts is necessarily lossy past 2^53 us, but should not be NaN.
    expect(Number.isFinite(parsed.traceEvents[0]!.ts)).toBe(true)
  })
})
