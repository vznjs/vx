// GET /v1/analysis — period-over-period comparison (this window vs the
// previous equal-length window). Ingests run summaries with per-window
// durations and asserts the endpoint reports the headline stats + the tasks
// whose average duration moved most. Standalone so it never collides with
// concurrent serve.test.ts edits.

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord } from '@vzn/vx'
import { startServe } from '../src/cli/serve.js'

const DAY = 86_400_000

function summary(
  runId: string,
  task: string,
  status: 'success' | 'failed',
  durationMs: number,
  at: number,
): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-an',
      workspaceName: 'an-ws',
      command: `vx run ${task}`,
      requestedTasks: [task],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 1,
      flow: 'broad',
      commitSha: `c-${runId}`,
      branch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: at,
    endedAt: at + durationMs,
    totalDurationMs: durationMs,
    taskCount: 1,
    failedCount: status === 'failed' ? 1 : 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: status !== 'failed',
    tasks: [
      {
        taskId: `demo#${task}`,
        project: 'demo',
        task,
        status,
        cacheSource: 'miss',
        exitCode: status === 'failed' ? 1 : 0,
        durationMs,
        hash: `h-${task}-${at}`,
      },
    ],
  }
}

let dir: string
let server: Awaited<ReturnType<typeof startServe>>
const auth = { authorization: 'Bearer an-tok' }

afterEach(async () => {
  await server?.stop()
  await rm(dir, { recursive: true, force: true })
})

async function push(s: RunSummaryRecord): Promise<void> {
  const res = await fetch(`${server.origin}/v1/ingest`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!res.ok) throw new Error(`ingest ${res.status}`)
}

interface AnalysisBody {
  windowDays: number
  current: { stats: { taskRuns: number; failures: number; avgDurationMs: number } }
  previous: { stats: { taskRuns: number; failures: number } }
  movers: Array<{ task: string; currentAvgMs: number; previousAvgMs: number; deltaMs: number }>
}

describe('GET /v1/analysis', () => {
  it('reports two-window stats + the top duration mover', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-an-serve-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'an-tok' })
    const now = Date.now()
    // Previous window (7-14d ago): `build` averages 100ms over 3 runs.
    for (let i = 0; i < 3; i++)
      await push(summary(`p${i}`, 'build', 'success', 100, now - 10 * DAY))
    // Current window (0-7d ago): `build` averages 400ms over 3 runs + a fail.
    for (let i = 0; i < 3; i++) await push(summary(`c${i}`, 'build', 'success', 400, now - 3 * DAY))
    await push(summary('cf', 'build', 'failed', 0, now - 2 * DAY))

    const noAuth = await fetch(`${server.origin}/v1/analysis`)
    expect(noAuth.status).toBe(401)

    const res = await fetch(`${server.origin}/v1/analysis`, { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as AnalysisBody
    expect(body.windowDays).toBe(7)
    expect(body.current.stats.taskRuns).toBe(4)
    expect(body.current.stats.failures).toBe(1)
    expect(body.current.stats.avgDurationMs).toBe(400)
    expect(body.previous.stats.taskRuns).toBe(3)
    const mover = body.movers.find((m) => m.task === 'build')!
    expect(mover.currentAvgMs).toBe(400)
    expect(mover.previousAvgMs).toBe(100)
    expect(mover.deltaMs).toBe(300)
  })

  it('honors ?window= and ?minRuns=', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-an-serve-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'an-tok' })
    const now = Date.now()
    // One run per window — under the default minRuns=3, no movers.
    await push(summary('p0', 'build', 'success', 100, now - 4 * DAY))
    await push(summary('c0', 'build', 'success', 900, now - 1 * DAY))

    const three = (await (
      await fetch(`${server.origin}/v1/analysis?window=3`, { headers: auth })
    ).json()) as AnalysisBody
    expect(three.windowDays).toBe(3)
    expect(three.movers).toHaveLength(0)

    const one = (await (
      await fetch(`${server.origin}/v1/analysis?window=3&minRuns=1`, { headers: auth })
    ).json()) as AnalysisBody
    expect(one.movers.map((m) => m.task)).toEqual(['build'])
  })

  it('?project=&task= scope the windows to one entity', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-an-serve-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'an-tok' })
    const now = Date.now()
    await push(summary('a1', 'build', 'success', 100, now - 3 * DAY))
    await push(summary('a2', 'lint', 'success', 50, now - 3 * DAY))

    const scoped = (await (
      await fetch(`${server.origin}/v1/analysis?project=demo&task=build`, { headers: auth })
    ).json()) as AnalysisBody
    expect(scoped.current.stats.taskRuns).toBe(1) // only build's row

    const none = (await (
      await fetch(`${server.origin}/v1/analysis?project=absent`, { headers: auth })
    ).json()) as AnalysisBody
    expect(none.current.stats.taskRuns).toBe(0)
  })
})
