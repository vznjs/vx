// The `--profile` artifact. `run-artifacts.ts` is a pure writer; we feed it
// synthetic outcomes and parse the resulting JSON to verify the shape
// chrome://tracing depends on.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeRunProfile } from '../src/orchestrator/run-artifacts.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { type Logger } from '../src/orchestrator/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

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

  it('an outcome with a start and no end is not an event: its duration is unknown', async () => {
    const out = await writeRunProfile({
      target: path.join(tmp, 'profile.json'),
      cwd: tmp,
      outcomes: [outcome({ node: execNode('pkg', 'cut'), wallclockStartNs: 5_000n })],
    })
    const parsed = JSON.parse(await readFile(out, 'utf8')) as { traceEvents: unknown[] }
    expect(parsed.traceEvents).toEqual([])
  })

  it('a relative target resolves against cwd, not the process directory', async () => {
    const out = await writeRunProfile({
      target: path.join('nested', 'profile.json'),
      cwd: tmp,
      outcomes: [],
    })
    expect(out).toBe(path.join(tmp, 'nested', 'profile.json'))
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ traceEvents: [] })
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

// The writers above are pinned; the CALLER's failure handling was not.
// `--profile` is asked for explicitly, so when the write fails the user gets no file — and the status line is the only
// thing that says why. Silencing both broke nothing in the repo (item
// 458), which is the same shape as 444, 450 and 457: a message that
// exists because the failure is otherwise inexplicable, held by
// nothing. A failed artifact write must also NOT fail the run: the
// tasks did their work.
describe('an artifact write that fails is a status line, not a failed run', () => {
  let root: string

  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-artifact-fail-' })
    await addProject(
      root,
      'app',
      "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    // A FILE where a directory has to be: the writer's mkdir gets ENOTDIR.
    await writeFile(path.join(root, 'blocker'), 'not a directory\n')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const statuses = (): { log: Logger; lines: string[] } => {
    const lines: string[] = []
    return {
      lines,
      log: {
        status(line: string) {
          lines.push(line)
        },
        taskStart() {},
        taskStdout() {},
        taskStderr() {},
        taskComplete() {},
      } as unknown as Logger,
    }
  }

  it('names the profile it could not write, and the run still succeeds', async () => {
    const { log, lines } = statuses()
    const summary = await run({
      cwd: root,
      tasks: ['build'],
      profile: path.join(root, 'blocker', 'out.json'),
      log,
      handleSignals: false,
    })
    // The run is green: the task ran, only the artifact did not land.
    expect(summary.ok).toBe(true)
    const said = lines.filter((l) => l.includes('failed to write profile'))
    expect(said).toHaveLength(1)
    // Actionable means naming the cause, not just the verb.
    expect(said[0]).toMatch(/blocker/)
  }, 30_000)
})
