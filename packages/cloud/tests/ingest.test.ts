// The cloud ingest path: IngestStore routes pushed RunSummaryRecords into
// per-workspace stores (one core Cache per workspace under the ingest root)
// that core's metrics queries read unchanged, and serve persists POST
// /v1/ingest there + serves it over /v1/* with `?ws=` scoping (the ONLY data
// source — vx-cloud never reads a workspace cache.db).

import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { getRun, listInvocations, listRuns, type RunSummaryRecord } from '@vzn/vx'
import { IngestStore } from '../src/ingest-store.js'
import { startServe } from '../src/cli/serve.js'

function summary(runId: string, over: Partial<RunSummaryRecord['run']> = {}): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-test',
      workspaceName: 'fixture-ws',
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

/** A pre-workspace-identity (v1) push: no workspaceId/workspaceName. */
function v1Summary(runId: string): RunSummaryRecord {
  const s = summary(runId) as unknown as { v: number; run: Record<string, unknown> }
  s.v = 1
  delete s.run['workspaceId']
  delete s.run['workspaceName']
  return s as never
}

describe('IngestStore', () => {
  it('round-trips a RunSummaryRecord into runs + invocations the metrics queries read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-'))
    const store = new IngestStore(dir)
    try {
      const stored = store.ingest(summary('run-1'))
      expect(stored).toBe(true)

      const db = store.db('ws-test')!
      // listRuns is per-task: 2 tasks → 2 rows, both under run-1.
      const runs = listRuns(db, { limit: 100 })
      expect(runs.length).toBe(2)
      expect(runs.every((r) => r.runId === 'run-1')).toBe(true)

      const invs = listInvocations(db, {})
      expect(invs.length).toBe(1)
      expect(invs[0]!.runId).toBe('run-1')
      expect(invs[0]!.branch).toBe('main')
      expect(invs[0]!.taskCount).toBe(2)

      const detail = getRun(db, 'run-1')
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
      const db = store.db('ws-test')!
      expect(listRuns(db, { limit: 100 }).length).toBe(2) // 2 tasks, not 4
      expect(listInvocations(db, {}).length).toBe(1)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('routes summaries into one store per workspace and lists both in the manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-multi-'))
    const store = new IngestStore(dir)
    try {
      store.ingest(summary('run-a', { workspaceId: 'ws-a', workspaceName: 'acme/a' }))
      store.ingest(summary('run-b', { workspaceId: 'ws-b', workspaceName: 'acme/b' }))

      // Two isolated stores on disk, each holding only its own run.
      expect(existsSync(path.join(dir, 'ws-a', 'cache.db'))).toBe(true)
      expect(existsSync(path.join(dir, 'ws-b', 'cache.db'))).toBe(true)
      const runsA = listRuns(store.db('ws-a')!, { limit: 100 })
      expect(runsA.length).toBe(2)
      expect(runsA.every((r) => r.runId === 'run-a')).toBe(true)
      const runsB = listRuns(store.db('ws-b')!, { limit: 100 })
      expect(runsB.every((r) => r.runId === 'run-b')).toBe(true)

      // The manifest lists both with display metadata + run counts.
      const wss = store.workspaces()
      expect(wss.map((w) => w.id).sort()).toEqual(['ws-a', 'ws-b'])
      expect(wss.find((w) => w.id === 'ws-a')!.name).toBe('acme/a')
      expect(wss.every((w) => w.runCount === 1)).toBe(true)
      expect(wss.every((w) => w.lastSeenAt > 0)).toBe(true)

      // Unknown ids resolve to nothing (and never touch the filesystem).
      expect(store.db('nope')).toBeUndefined()
      expect(store.db('../escape')).toBeUndefined()
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a v1 push (no workspace fields) lands in the default workspace', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-v1-'))
    const store = new IngestStore(dir)
    try {
      expect(store.ingest(v1Summary('run-v1'))).toBe(true)
      const db = store.db('default')!
      expect(listInvocations(db, {}).some((i) => i.runId === 'run-v1')).toBe(true)
      const wss = store.workspaces()
      expect(wss.map((w) => w.id)).toEqual(['default'])
      expect(wss[0]!.name).toBe('default')
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('survives a store reopen — manifest + per-workspace data persist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-persist-'))
    try {
      const first = new IngestStore(dir)
      first.ingest(summary('run-a', { workspaceId: 'ws-a', workspaceName: 'acme/a' }))
      first.close()

      const second = new IngestStore(dir)
      try {
        expect(second.workspaces().map((w) => w.id)).toEqual(['ws-a'])
        expect(listInvocations(second.db('ws-a')!, {}).length).toBe(1)
        // Sole workspace → it is the un-scoped default.
        expect(second.defaultWorkspaceId()).toBe('ws-a')
      } finally {
        second.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats a legacy single-store dir (root-level cache.db) as workspace default', async () => {
    // Seed a store the new way, then reshape it into the legacy layout:
    // cache.db directly at the ingest root — the pre-multi-workspace disk.
    const seedDir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-seed-'))
    const legacyDir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-legacy-'))
    try {
      const seeded = new IngestStore(seedDir)
      seeded.ingest(v1Summary('run-legacy'))
      seeded.close()
      // WAL sidecars persist across close and carry recent writes — a real
      // legacy dir holds all three, and the migration must move all three.
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(path.join(seedDir, 'default', `cache.db${suffix}`))) {
          await rename(
            path.join(seedDir, 'default', `cache.db${suffix}`),
            path.join(legacyDir, `cache.db${suffix}`),
          )
        }
      }

      const warnings: string[] = []
      const store = new IngestStore(legacyDir, (m) => warnings.push(m))
      try {
        // Moved on boot (loudly), history intact under `default`.
        expect(warnings.some((w) => w.includes('migrated legacy'))).toBe(true)
        expect(existsSync(path.join(legacyDir, 'default', 'cache.db'))).toBe(true)
        expect(existsSync(path.join(legacyDir, 'cache.db'))).toBe(false)
        expect(
          listInvocations(store.db('default')!, {}).some((i) => i.runId === 'run-legacy'),
        ).toBe(true)
        expect(store.workspaces().map((w) => w.id)).toEqual(['default'])
      } finally {
        store.close()
      }
    } finally {
      await rm(seedDir, { recursive: true, force: true })
      await rm(legacyDir, { recursive: true, force: true })
    }
  })

  it('warns loudly when core Cache schema gate wipes the stored history (upgrade across a bump)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-wipe-'))
    try {
      // Seed history, then simulate a vx upgrade across a SCHEMA_VERSION
      // bump by rewriting the version core's drop-gate checks.
      const seeded = new IngestStore(dir)
      seeded.ingest(summary('run-wipe-1'))
      seeded.close()
      const db = new Database(path.join(dir, 'ws-test', 'cache.db'))
      db.prepare("UPDATE schema_meta SET value = 'v0-outdated' WHERE key = 'version'").run()
      db.close()

      const warnings: string[] = []
      const reopened = new IngestStore(dir, (m) => warnings.push(m))
      try {
        // The gate dropped + recreated the tables — history is gone, and
        // the store said so instead of silently serving an empty dashboard.
        expect(listInvocations(reopened.db('ws-test')!, {}).length).toBe(0)
        expect(
          warnings.some((w) => w.includes('run history for workspace "ws-test" was reset')),
        ).toBe(true)
      } finally {
        reopened.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not warn on a normal reopen (same schema version)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-ingest-reopen-'))
    try {
      const seeded = new IngestStore(dir)
      seeded.ingest(summary('run-keep-1'))
      seeded.close()

      const warnings: string[] = []
      const reopened = new IngestStore(dir, (m) => warnings.push(m))
      try {
        expect(listInvocations(reopened.db('ws-test')!, {}).length).toBe(1)
        expect(warnings).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
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

      // The sole ingested workspace is the un-scoped default, so the read
      // APIs behave exactly like a single-workspace serve.
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

  it('scopes /v1/* by ?ws= and lists workspaces via /v1/workspaces', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'vx-multi-ws-'))
    const server = await startServe({ root: dataDir, ingestDir: dataDir })
    try {
      await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summary('run-a', { workspaceId: 'ws-a', workspaceName: 'acme/a' })),
      })
      await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summary('run-b', { workspaceId: 'ws-b', workspaceName: 'acme/b' })),
      })

      // /v1/workspaces lists both with metadata.
      const wss = (await (await fetch(`${server.origin}/v1/workspaces`)).json()) as {
        workspaces: { id: string; name: string; runCount: number }[]
      }
      expect(wss.workspaces.map((w) => w.id).sort()).toEqual(['ws-a', 'ws-b'])
      expect(wss.workspaces.find((w) => w.id === 'ws-b')!.name).toBe('acme/b')

      // ?ws= scopes every analytics read to one workspace's store.
      const runsA = (await (await fetch(`${server.origin}/v1/runs?ws=ws-a`)).json()) as {
        runs: { runId: string }[]
      }
      expect(runsA.runs.length).toBeGreaterThan(0)
      expect(runsA.runs.every((r) => r.runId === 'run-a')).toBe(true)
      const invsB = (await (await fetch(`${server.origin}/v1/invocations?ws=ws-b`)).json()) as {
        invocations: { runId: string }[]
      }
      expect(invsB.invocations.map((i) => i.runId)).toEqual(['run-b'])

      // An unknown workspace 404s; with several workspaces and no genuine
      // `default` store, the un-scoped read falls back to the
      // most-recently-seen workspace (ws-b here — ingested last), so a
      // fresh dashboard never opens onto an empty synthetic workspace.
      expect((await fetch(`${server.origin}/v1/runs?ws=nope`)).status).toBe(404)
      const unscoped = (await (await fetch(`${server.origin}/v1/runs`)).json()) as {
        runs: { runId: string }[]
      }
      expect(unscoped.runs.every((r) => r.runId === 'run-b')).toBe(true)

      // /v1/meta reports the count only (pre-auth surface — no names).
      const meta = (await (await fetch(`${server.origin}/v1/meta`)).json()) as {
        workspaces: number
      }
      expect(meta.workspaces).toBe(2)
    } finally {
      await server.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('gates /v1/workspaces behind the bearer token', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'vx-ws-auth-'))
    const server = await startServe({ root: dataDir, ingestDir: dataDir, token: 'sekret' })
    try {
      expect((await fetch(`${server.origin}/v1/workspaces`)).status).toBe(401)
      const ok = await fetch(`${server.origin}/v1/workspaces`, {
        headers: { authorization: 'Bearer sekret' },
      })
      expect(ok.status).toBe(200)
    } finally {
      await server.stop()
      await rm(dataDir, { recursive: true, force: true })
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
