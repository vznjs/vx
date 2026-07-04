// The serve's task-log routes: POST /v1/ingest/logs (version + body-cap +
// workspace routing) and GET /v1/runs/:id/logs/:taskId (direct row, the
// cache-hit → hash resolution, the 404, and the version gate).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { startServe } from '../src/cli/serve.js'
import { serveInfoPath } from '../src/serve-info.js'
import { LOG_WIRE_VERSION, type TaskLogBundle } from '../src/task-log-capture.js'

const prev = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-tasklogs-${process.pid}.json`,
  )
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prev === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prev
})

const WS = 'ws-logs'

function summary(runId: string, tasks: Partial<TaskTelemetry>[]): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: WS,
      workspaceName: 'logs-fixture',
      command: 'vx run build',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: 'full',
      commitSha: null,
      branch: null,
      dirty: null,
      ci: false,
      ciProvider: null,
      host: null,
      os: null,
      arch: null,
      tags: {},
    },
    startedAt: Date.now(),
    endedAt: Date.now(),
    totalDurationMs: 1,
    taskCount: tasks.length,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: tasks.map(
      (t): TaskTelemetry => ({
        taskId: t.taskId ?? 'p#build',
        project: (t.taskId ?? 'p#build').split('#')[0]!,
        task: (t.taskId ?? 'p#build').split('#')[1]!,
        status: t.status ?? 'success',
        cacheSource: t.cacheSource ?? 'miss',
        exitCode: t.exitCode ?? 0,
        durationMs: 1,
        ...(t.hash !== undefined ? { hash: t.hash } : {}),
      }),
    ),
  }
}

function bundle(runId: string, tasks: TaskLogBundle['tasks']): TaskLogBundle {
  return { v: LOG_WIRE_VERSION, runId, workspaceId: WS, tasks }
}

async function post(origin: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('serve — task-log routes', () => {
  it('stores a pushed bundle and serves it back for an executed task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-tasklogs-'))
    const server = await startServe({ root, ingestDir: root })
    try {
      await post(server.origin, '/v1/ingest', summary('run-1', [{ taskId: 'p#build' }]))
      const ingested = await post(
        server.origin,
        '/v1/ingest/logs',
        bundle('run-1', [
          {
            taskId: 'p#build',
            status: 'failed',
            content: 'compile error: boom\n',
            charsFull: 20,
            truncatedHeadChars: 0,
          },
        ]),
      )
      expect(ingested.status).toBe(200)
      expect(await ingested.json()).toEqual({ ok: true, stored: 1 })

      const got = await fetch(
        `${server.origin}/v1/runs/run-1/logs/${encodeURIComponent('p#build')}`,
      )
      expect(got.status).toBe(200)
      const body = (await got.json()) as Record<string, unknown>
      expect(body['source']).toBe('executed')
      expect(body['status']).toBe('failed')
      expect(body['content']).toBe('compile error: boom\n')
      // The raw cache-key hash is never leaked to the client.
      expect(body).not.toHaveProperty('hash')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a cache-hit task to the run that produced the bytes (by hash)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-tasklogs-'))
    const server = await startServe({ root, ingestDir: root })
    try {
      // Run 1 EXECUTED the task (miss) and captured its output under hash h1.
      await post(server.origin, '/v1/ingest', summary('run-1', [{ taskId: 'p#build', hash: 'h1' }]))
      await post(
        server.origin,
        '/v1/ingest/logs',
        bundle('run-1', [
          {
            taskId: 'p#build',
            status: 'success',
            hash: 'h1',
            content: 'built from source\n',
            charsFull: 18,
            truncatedHeadChars: 0,
          },
        ]),
      )
      // Run 2 was a cache HIT on the same hash — it stored NO logs of its own.
      await post(
        server.origin,
        '/v1/ingest',
        summary('run-2', [
          { taskId: 'p#build', hash: 'h1', status: 'cache-hit', cacheSource: 'local' },
        ]),
      )

      const got = await fetch(
        `${server.origin}/v1/runs/run-2/logs/${encodeURIComponent('p#build')}`,
      )
      expect(got.status).toBe(200)
      const body = (await got.json()) as Record<string, unknown>
      expect(body['source']).toBe('cache')
      expect(body['refRunId']).toBe('run-1')
      expect(body['content']).toBe('built from source\n')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('404s a task with no captured logs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-tasklogs-'))
    const server = await startServe({ root, ingestDir: root })
    try {
      await post(server.origin, '/v1/ingest', summary('run-1', [{ taskId: 'p#build' }]))
      const got = await fetch(
        `${server.origin}/v1/runs/run-1/logs/${encodeURIComponent('p#build')}`,
      )
      expect(got.status).toBe(404)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('400s an unknown log wire version, naming both', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-tasklogs-'))
    const server = await startServe({ root, ingestDir: root })
    try {
      const res = await post(server.origin, '/v1/ingest/logs', {
        v: 99,
        runId: 'r',
        workspaceId: WS,
        tasks: [],
      })
      expect(res.status).toBe(400)
      expect(String((await res.json()).error)).toContain('v99')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
