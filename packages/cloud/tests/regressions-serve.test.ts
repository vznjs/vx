// GET /v1/regressions — tasks that started failing across branches. Ingests
// run summaries (the only way data reaches vx-cloud) with per-branch statuses
// and asserts the endpoint names the cross-branch regression. Standalone so it
// never collides with concurrent serve.test.ts edits.

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
  branch: string,
  status: 'success' | 'failed' | 'cache-hit',
  at: number,
): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-reg',
      workspaceName: 'reg-ws',
      command: `vx run ${task}`,
      requestedTasks: [task],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 1,
      flow: 'broad',
      commitSha: `c-${runId}`,
      branch,
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: at,
    endedAt: at + 100,
    totalDurationMs: 100,
    taskCount: 1,
    failedCount: status === 'failed' ? 1 : 0,
    hitCount: status === 'cache-hit' ? 1 : 0,
    hitLocalCount: status === 'cache-hit' ? 1 : 0,
    hitRemoteCount: 0,
    exitOk: status !== 'failed',
    tasks: [
      {
        taskId: `demo#${task}`,
        project: 'demo',
        task,
        status,
        cacheSource: status === 'cache-hit' ? 'local' : 'miss',
        exitCode: status === 'failed' ? 1 : 0,
        durationMs: 50,
        hash: `h-${task}-${branch}-${at}`,
      },
    ],
  }
}

let dir: string
let server: Awaited<ReturnType<typeof startServe>>
const auth = { authorization: 'Bearer reg-tok' }

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

describe('GET /v1/regressions', () => {
  it('names a task now failing across two branches that used to pass', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-reg-serve-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'reg-tok' })
    const now = Date.now()
    await push(summary('r1', 'build', 'main', 'success', now - 8 * DAY))
    await push(summary('r2', 'build', 'main', 'failed', now - 2 * DAY))
    await push(summary('r3', 'build', 'dev', 'failed', now - 1 * DAY))

    const noAuth = await fetch(`${server.origin}/v1/regressions`)
    expect(noAuth.status).toBe(401)

    const res = await fetch(`${server.origin}/v1/regressions`, { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tasks: Array<{ id: string; branchesFailing: number; branches: string[]; regressed: boolean }>
    }
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]!.id).toBe('demo#build')
    expect(body.tasks[0]!.branchesFailing).toBe(2)
    expect(body.tasks[0]!.branches.sort()).toEqual(['dev', 'main'])
    expect(body.tasks[0]!.regressed).toBe(true)
  })

  it('minBranches=1 surfaces a single-branch regression; the default (2) does not', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-reg-serve-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'reg-tok' })
    const now = Date.now()
    await push(summary('r1', 'lint', 'main', 'success', now - 5 * DAY))
    await push(summary('r2', 'lint', 'main', 'failed', now - 1 * DAY))

    const dflt = (await (
      await fetch(`${server.origin}/v1/regressions`, { headers: auth })
    ).json()) as {
      tasks: unknown[]
    }
    expect(dflt.tasks).toHaveLength(0)

    const one = (await (
      await fetch(`${server.origin}/v1/regressions?minBranches=1`, { headers: auth })
    ).json()) as { tasks: Array<{ id: string }> }
    expect(one.tasks.map((t) => t.id)).toEqual(['demo#lint'])
  })
})
