import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from './cache.js'
import {
  createDashboardServer,
  handleRequest,
  type CacheEntryRow,
  type OverviewResponse,
  type RunSummary,
  type SlowestTask,
  type TaskRow,
} from './dashboard.js'
import { Database } from 'bun:sqlite'

let cacheDir: string
let cache: Cache

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vzn-dash-'))
  cache = new Cache(cacheDir)
})

afterEach(async () => {
  cache.close()
  await rm(cacheDir, { recursive: true, force: true })
})

function openReadonly(): Database {
  return new Database(path.join(cacheDir, 'cache.db'), { readonly: true })
}

function seedRun(opts: {
  runId: string
  startedAt: number
  tasks: Array<{
    project: string
    task: string
    status: 'success' | 'failed' | 'cache-hit'
    durationMs: number
    cpuMs?: number
    peakRssBytes?: number
    wallclockStartNs?: bigint
    wallclockEndNs?: bigint
  }>
}): void {
  for (const t of opts.tasks) {
    const hash = `h-${opts.runId}-${t.project}-${t.task}`
    cache.recordRun({
      hash,
      project: t.project,
      task: t.task,
      status: t.status,
      exitCode: t.status === 'failed' ? 1 : 0,
      durationMs: t.durationMs,
      startedAt: opts.startedAt,
      endedAt: opts.startedAt + t.durationMs,
      runId: opts.runId,
      cacheHit: t.status === 'cache-hit',
      ...(t.cpuMs !== undefined ? { cpuMs: t.cpuMs } : {}),
      ...(t.peakRssBytes !== undefined ? { peakRssBytes: t.peakRssBytes } : {}),
      ...(t.wallclockStartNs !== undefined ? { wallclockStartNs: t.wallclockStartNs } : {}),
      ...(t.wallclockEndNs !== undefined ? { wallclockEndNs: t.wallclockEndNs } : {}),
    })
  }
}

describe('handleRequest /api/health', () => {
  it('returns { ok: true }', async () => {
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/health'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      db.close()
    }
  })
})

describe('handleRequest /api/overview', () => {
  it('returns cache stats + recent runs on a fresh DB', async () => {
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/overview'))
      const body = (await res.json()) as OverviewResponse
      expect(body.cache.entryCount).toBe(0)
      expect(body.cache.totalBytes).toBe(0)
      expect(body.cache.runCountLast24h).toBe(0)
      expect(body.cache.hitCountLast24h).toBe(0)
      expect(body.cache.hitRateLast24h).toBeNull()
      expect(body.recentRuns).toEqual([])
    } finally {
      db.close()
    }
  })

  it('populates cache stats and recent runs after seeding', async () => {
    const now = Date.now()
    seedRun({
      runId: 'R1',
      startedAt: now - 1000,
      tasks: [
        { project: 'a', task: 'build', status: 'success', durationMs: 500 },
        { project: 'b', task: 'test', status: 'cache-hit', durationMs: 0 },
      ],
    })
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/overview'))
      const body = (await res.json()) as OverviewResponse
      expect(body.cache.runCountLast24h).toBe(2)
      expect(body.cache.hitCountLast24h).toBe(1)
      expect(body.cache.hitRateLast24h).toBeCloseTo(0.5)
      expect(body.recentRuns).toHaveLength(1)
      expect(body.recentRuns[0]!.runId).toBe('R1')
      expect(body.recentRuns[0]!.taskCount).toBe(2)
      expect(body.recentRuns[0]!.successCount).toBe(1)
      expect(body.recentRuns[0]!.cacheHitCount).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe('handleRequest /api/runs', () => {
  it('returns runs in startedAt-DESC order, grouped by run_id', async () => {
    const now = Date.now()
    seedRun({
      runId: 'OLDEST',
      startedAt: now - 30_000,
      tasks: [{ project: 'a', task: 't', status: 'success', durationMs: 100 }],
    })
    seedRun({
      runId: 'NEWEST',
      startedAt: now - 1_000,
      tasks: [{ project: 'a', task: 't', status: 'success', durationMs: 200 }],
    })
    seedRun({
      runId: 'MIDDLE',
      startedAt: now - 10_000,
      tasks: [{ project: 'a', task: 't', status: 'failed', durationMs: 50 }],
    })
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/runs'))
      const runs = (await res.json()) as RunSummary[]
      expect(runs.map((r) => r.runId)).toEqual(['NEWEST', 'MIDDLE', 'OLDEST'])
      expect(runs.find((r) => r.runId === 'MIDDLE')!.failedCount).toBe(1)
    } finally {
      db.close()
    }
  })

  it('respects ?limit=', async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      seedRun({
        runId: `R${i}`,
        startedAt: now - i * 1000,
        tasks: [{ project: 'a', task: 't', status: 'success', durationMs: 10 }],
      })
    }
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/runs?limit=2'))
      const runs = (await res.json()) as RunSummary[]
      expect(runs).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('respects ?since= filter', async () => {
    const now = Date.now()
    seedRun({
      runId: 'OLD',
      startedAt: now - 100_000,
      tasks: [{ project: 'a', task: 't', status: 'success', durationMs: 1 }],
    })
    seedRun({
      runId: 'NEW',
      startedAt: now - 1_000,
      tasks: [{ project: 'a', task: 't', status: 'success', durationMs: 1 }],
    })
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request(`http://x/api/runs?since=${now - 50_000}`))
      const runs = (await res.json()) as RunSummary[]
      expect(runs.map((r) => r.runId)).toEqual(['NEW'])
    } finally {
      db.close()
    }
  })

  it('ignores rows with NULL run_id (legacy pre-PR#21 data)', async () => {
    // Insert directly to bypass the runId requirement.
    const db2 = new Database(path.join(cacheDir, 'cache.db'))
    db2.exec(
      "INSERT INTO runs(hash,project,task,status,exit_code,duration_ms,started_at,ended_at) VALUES ('x','p','t','success',0,1,1,2)",
    )
    db2.close()
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/runs'))
      const runs = (await res.json()) as RunSummary[]
      expect(runs).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('handleRequest /api/runs/:id', () => {
  it('returns all tasks for a run in wallclock order', async () => {
    const now = Date.now()
    seedRun({
      runId: 'R1',
      startedAt: now,
      tasks: [
        {
          project: 'a',
          task: 't1',
          status: 'success',
          durationMs: 100,
          wallclockStartNs: 0n,
          wallclockEndNs: 100_000_000n,
          cpuMs: 50,
          peakRssBytes: 1_048_576,
        },
        {
          project: 'b',
          task: 't2',
          status: 'success',
          durationMs: 50,
          wallclockStartNs: 200_000_000n,
          wallclockEndNs: 250_000_000n,
        },
      ],
    })
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/runs/R1'))
      const body = (await res.json()) as { runId: string; tasks: TaskRow[] }
      expect(body.runId).toBe('R1')
      expect(body.tasks).toHaveLength(2)
      expect(body.tasks[0]!.task).toBe('t1')
      expect(body.tasks[0]!.wallclockStartNs).toBe('0')
      expect(body.tasks[0]!.cpuMs).toBe(50)
      expect(body.tasks[0]!.peakRssBytes).toBe(1_048_576)
      expect(body.tasks[1]!.task).toBe('t2')
      expect(body.tasks[1]!.wallclockStartNs).toBe('200000000')
    } finally {
      db.close()
    }
  })

  it('returns an empty tasks list for an unknown run_id', async () => {
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/runs/UNKNOWN'))
      const body = (await res.json()) as { runId: string; tasks: TaskRow[] }
      expect(body.runId).toBe('UNKNOWN')
      expect(body.tasks).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('handleRequest /api/tasks/slowest', () => {
  it('ranks tasks by average duration, exclusive of cache-hits', async () => {
    const now = Date.now()
    seedRun({
      runId: 'R1',
      startedAt: now,
      tasks: [
        { project: 'a', task: 'fast', status: 'success', durationMs: 10 },
        { project: 'a', task: 'slow', status: 'success', durationMs: 500 },
      ],
    })
    seedRun({
      runId: 'R2',
      startedAt: now,
      tasks: [
        { project: 'a', task: 'fast', status: 'success', durationMs: 20 },
        { project: 'a', task: 'slow', status: 'success', durationMs: 600 },
        // cache-hits never count toward slowest.
        { project: 'a', task: 'slow', status: 'cache-hit', durationMs: 0 },
      ],
    })
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/tasks/slowest?limit=10'))
      const rows = (await res.json()) as SlowestTask[]
      expect(rows[0]!.task).toBe('slow')
      expect(rows[0]!.avgDurationMs).toBe(550)
      expect(rows[0]!.maxDurationMs).toBe(600)
      expect(rows[0]!.runCount).toBe(2)
      expect(rows[1]!.task).toBe('fast')
    } finally {
      db.close()
    }
  })
})

describe('handleRequest /api/cache/entries', () => {
  it('lists entries in accessed_at-DESC order', async () => {
    // recordRun() doesn't insert into `entries`; we need a real save().
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'vzn-dash-proj-'))
    try {
      await cache.save({
        hash: 'h-old',
        projectDir,
        outputFiles: [],
        entry: {
          taskId: 'a#build',
          command: 'echo old',
          exitCode: 0,
          durationMs: 5,
          stdout: '',
          stderr: '',
        },
      })
      // Force a different accessed_at on the second one.
      await new Promise((r) => setTimeout(r, 5))
      await cache.save({
        hash: 'h-new',
        projectDir,
        outputFiles: [],
        entry: {
          taskId: 'a#test',
          command: 'echo new',
          exitCode: 0,
          durationMs: 7,
          stdout: '',
          stderr: '',
        },
      })
      const db = openReadonly()
      try {
        const res = await handleRequest(db, new Request('http://x/api/cache/entries'))
        const rows = (await res.json()) as CacheEntryRow[]
        expect(rows.map((r) => r.hash)).toEqual(['h-new', 'h-old'])
        expect(rows[0]!.task).toBe('test')
      } finally {
        db.close()
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})

describe('handleRequest unknown route', () => {
  it('returns 404 JSON', async () => {
    const db = openReadonly()
    try {
      const res = await handleRequest(db, new Request('http://x/api/whatever'))
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('not found')
    } finally {
      db.close()
    }
  })
})

describe('createDashboardServer', () => {
  it('starts a real HTTP server and serves /api/overview', async () => {
    // Pick an ephemeral port (0 → kernel assigns).
    const server = createDashboardServer({ cacheDir, port: 0, hostname: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/overview`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as OverviewResponse
      expect(body.cache.entryCount).toBe(0)
    } finally {
      void server.stop()
    }
  })

  it('creates an empty cache.db on first launch (no .vzn dir yet)', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'vzn-dash-empty-'))
    try {
      const server = createDashboardServer({ cacheDir: empty, port: 0, hostname: '127.0.0.1' })
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/health`)
        expect(res.status).toBe(200)
      } finally {
        void server.stop()
      }
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
