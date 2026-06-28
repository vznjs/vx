// The cloud ingest path: IngestStore round-trips a pushed RunSummaryRecord
// into a cloud-owned store that core's metrics queries read unchanged, and
// serve persists POST /v1/ingest there + serves it over /v1/* (the ONLY data
// source — vx-cloud never reads a workspace cache.db).

import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getRun, listInvocations, listRuns, type RunSummaryRecord } from '@vzn/vx'
import { IngestStore } from '../src/ingest-store.js'
import { startServe } from '../src/cli/serve.js'

function summary(runId: string, over: Partial<RunSummaryRecord['run']> = {}): RunSummaryRecord {
  return {
    v: 1,
    run: {
      runId,
      vxVersion: '0.0.0',
      command: 'vx run build',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 2,
      flow: 'broad',
      commitSha: 'c0ffee',
      branch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: { env: 'ci' },
      ...over,
    },
    startedAt: 1000,
    endedAt: 1200,
    totalDurationMs: 200,
    taskCount: 2,
    failedCount: 0,
    hitCount: 1,
    hitLocalCount: 1,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: 'a#build',
        project: 'a',
        task: 'build',
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 120,
        hash: 'h-a',
        wallclockStartNs: '0',
        wallclockEndNs: '120000000',
      },
      {
        taskId: 'b#build',
        project: 'b',
        task: 'build',
        status: 'cache-hit',
        cacheSource: 'local',
        exitCode: 0,
        durationMs: 2,
        hash: 'h-b',
      },
    ],
  }
}

describe('IngestStore', () => {
  it('round-trips a RunSummaryRecord into runs + invocations the metrics queries read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-'))
    const store = new IngestStore(dir)
    try {
      const stored = store.ingest(summary('run-1'))
      expect(stored).toBe(true)

      // listRuns is per-task: 2 tasks → 2 rows, both under run-1.
      const runs = listRuns(store.db(), { limit: 100 })
      expect(runs.length).toBe(2)
      expect(runs.every((r) => r.runId === 'run-1')).toBe(true)

      const invs = listInvocations(store.db(), {})
      expect(invs.length).toBe(1)
      expect(invs[0]!.runId).toBe('run-1')
      expect(invs[0]!.branch).toBe('main')
      expect(invs[0]!.taskCount).toBe(2)

      const detail = getRun(store.db(), 'run-1')
      expect(detail).not.toBeNull()
      expect(detail!.tasks.length).toBe(2)
      const a = detail!.tasks.find((t) => t.task === 'build' && t.project === 'a')!
      expect(a.cacheHit).toBe(false)
      const b = detail!.tasks.find((t) => t.project === 'b')!
      expect(b.cacheHit).toBe(true)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent on runId — a re-delivered summary stores nothing new', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-idem-'))
    const store = new IngestStore(dir)
    try {
      expect(store.ingest(summary('run-1'))).toBe(true)
      expect(store.ingest(summary('run-1'))).toBe(false)
      expect(listRuns(store.db(), { limit: 100 }).length).toBe(2) // 2 tasks, not 4
      expect(listInvocations(store.db(), {}).length).toBe(1)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// A minimal workspace so startServe can load a config + resolve a cache dir.
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-ingest-serve-'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  )
  await writeFile(
    path.join(root, 'vx.config.mjs'),
    'export default { tasks: { hello: { exec: { command: "echo hi" } } } }\n',
  )
  return root
}

describe('serve POST /v1/ingest + ingest-store reads', () => {
  it('ingests a pushed summary and serves it from the ingest store over /v1/*', async () => {
    const root = await makeWorkspace()
    const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-store-'))
    const server = await startServe({ root, ingestDir })
    try {
      // Push a run summary to the ingest endpoint.
      const res = await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summary('run-ingest-1')),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; stored: boolean }
      expect(body).toEqual({ ok: true, stored: true })

      // The read APIs (source:ingest) now serve it.
      const runsRes = await fetch(`${server.origin}/v1/runs`)
      const runs = (await runsRes.json()) as { runs: { runId: string }[] }
      expect(runs.runs.some((r) => r.runId === 'run-ingest-1')).toBe(true)

      const invRes = await fetch(`${server.origin}/v1/invocations`)
      const invs = (await invRes.json()) as { invocations: { runId: string }[] }
      expect(invs.invocations.some((i) => i.runId === 'run-ingest-1')).toBe(true)

      // A re-push is idempotent.
      const res2 = await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summary('run-ingest-1')),
      })
      expect(((await res2.json()) as { stored: boolean }).stored).toBe(false)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
      await rm(ingestDir, { recursive: true, force: true })
    }
  })

  it('runs STANDALONE in hosted mode — no workspace, ingest + serve from SQLite', async () => {
    // A bare directory: no package.json, no vx.config — NOT a workspace.
    const dataDir = await mkdtemp(path.join(tmpdir(), 'vx-hosted-'))
    const server = await startServe({ root: dataDir, ingestDir: dataDir })
    try {
      const res = await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summary('hosted-1')),
      })
      expect(res.status).toBe(200)

      const runs = (await (await fetch(`${server.origin}/v1/runs`)).json()) as {
        runs: { runId: string }[]
      }
      expect(runs.runs.some((r) => r.runId === 'hosted-1')).toBe(true)

      // The graph route needs a colocated workspace — unavailable standalone.
      const graph = await fetch(`${server.origin}/v1/graph?tasks=build`)
      expect(graph.ok).toBe(false)
    } finally {
      await server.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects a non-RunSummaryRecord body with 400', async () => {
    const root = await makeWorkspace()
    const server = await startServe({
      root,
      ingestDir: await mkdtemp(path.join(tmpdir(), 'vx-ing-')),
    })
    try {
      const res = await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ not: 'a summary' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
