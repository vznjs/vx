import { beforeAll, describe, expect, it } from 'bun:test'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics, WorkspaceForbiddenError } from '../src/db/analytics.js'
import type { TaskLogBundle } from '../src/task-log-capture.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

async function freshDb(): Promise<DbClient> {
  const pg = await ephemeralPg()
  return openDb(await pg.createDatabase())
}

/** Insert a bare organization (the FK anchor for workspaces/tokens). */
async function seedOrg(db: DbClient, slug = 'acme'): Promise<string> {
  const orgId = Bun.randomUUIDv7()
  await db.sql`INSERT INTO organizations (id, slug, name, created_at)
               VALUES (${orgId}, ${slug}, ${slug}, ${Date.now()})`
  return orgId
}

async function seedWorkspace(db: DbClient, orgId: string, slug = 'ws'): Promise<string> {
  const wsId = Bun.randomUUIDv7()
  await db.sql`INSERT INTO workspaces (id, org_id, slug, name, created_at)
               VALUES (${wsId}, ${orgId}, ${slug}, ${slug}, ${Date.now()})`
  return wsId
}

function task(
  over: Partial<TaskTelemetry> & Pick<TaskTelemetry, 'project' | 'task'>,
): TaskTelemetry {
  return {
    taskId: `${over.project}#${over.task}`,
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 100,
    hash: 'h0',
    ...over,
  }
}

function summary(over: {
  runId?: string
  workspaceId?: string
  workspaceName?: string
  startedAt?: number
  tasks?: TaskTelemetry[]
  branch?: string
  os?: string
  arch?: string
}): RunSummaryRecord {
  const startedAt = over.startedAt ?? Date.now()
  const tasks = over.tasks ?? [task({ project: 'app', task: 'build' })]
  return {
    v: 2,
    run: {
      runId: over.runId ?? Bun.randomUUIDv7(),
      vxVersion: '0.0.0',
      command: 'vx run build',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: 'broad',
      workspaceId: over.workspaceId ?? 'ws-hash-1',
      workspaceName: over.workspaceName ?? 'acme/app',
      commitSha: 'abc123',
      branch: over.branch ?? 'main',
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'runner-1',
      os: over.os ?? 'linux',
      arch: over.arch ?? 'x64',
      tags: { env: 'ci' },
    },
    startedAt,
    endedAt: startedAt + 500,
    totalDurationMs: 500,
    taskCount: tasks.length,
    failedCount: tasks.filter((t) => t.status === 'failed').length,
    hitCount: tasks.filter((t) => t.cacheSource === 'local' || t.cacheSource === 'remote').length,
    hitLocalCount: tasks.filter((t) => t.cacheSource === 'local').length,
    hitRemoteCount: tasks.filter((t) => t.cacheSource === 'remote').length,
    exitOk: tasks.every((t) => t.status !== 'failed'),
    tasks,
  }
}

let db: DbClient
let analytics: Analytics

beforeAll(async () => {
  db = await freshDb()
  analytics = new Analytics(db.sql)
})

describe('ingest', () => {
  it('routes an org-scoped push to an auto-provisioned workspace + repo + projects/tasks', async () => {
    const org = await seedOrg(db, 'ingest-1')
    const res = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'wshash1', workspaceName: 'acme/app' }),
    })
    expect(res.stored).toBe(true)
    expect(res.workspaceId).toMatch(/^[0-9a-f-]{36}$/)

    const ws = await db.sql<{ id: string; slug: string; name: string }[]>`
      SELECT id, slug, name FROM workspaces WHERE org_id = ${org}`
    expect(ws).toHaveLength(1)
    expect(ws[0]!.id).toBe(res.workspaceId)
    expect(ws[0]!.slug).toBe('acme-app')

    const repo = await db.sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM repos WHERE org_id = ${org} AND client_workspace_id = ${'wshash1'}`
    expect(repo[0]!.workspace_id).toBe(res.workspaceId)

    const inv = await db.sql<{ workspace_id: string; org_id: string; branch: string }[]>`
      SELECT workspace_id, org_id, branch FROM invocations`
    expect(inv).toHaveLength(1)
    expect(inv[0]!.workspace_id).toBe(res.workspaceId)
    expect(inv[0]!.org_id).toBe(org)

    const trs = await db.sql<{ project: string; task: string }[]>`
      SELECT project, task FROM task_runs WHERE workspace_id = ${res.workspaceId}`
    expect(trs).toHaveLength(1)
    expect(trs[0]).toEqual({ project: 'app', task: 'build' })

    const projects = await db.sql<{ name: string }[]>`
      SELECT name FROM projects WHERE workspace_id = ${res.workspaceId}`
    expect(projects.map((p) => p.name)).toEqual(['app'])
    const pt = await db.sql<{ task: string }[]>`
      SELECT pt.task FROM project_tasks pt
      JOIN projects p ON p.id = pt.project_id WHERE p.workspace_id = ${res.workspaceId}`
    expect(pt.map((r) => r.task)).toEqual(['build'])
  })

  it('is idempotent on re-delivery — same runId stores nothing new', async () => {
    const org = await seedOrg(db, 'ingest-idem')
    const s = summary({
      runId: 'run-idem',
      workspaceId: 'w',
      tasks: [task({ project: 'a', task: 'b' })],
    })
    const first = await analytics.ingest({ orgId: org, summary: s })
    expect(first.stored).toBe(true)
    const second = await analytics.ingest({ orgId: org, summary: s })
    expect(second.stored).toBe(false)
    expect(second.workspaceId).toBe(first.workspaceId)
    const inv = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM invocations WHERE run_id = ${'run-idem'}`
    expect(inv[0]!.c).toBe(1)
    const trs = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM task_runs WHERE run_id = ${'run-idem'}`
    expect(trs[0]!.c).toBe(1)
  })

  it('drops a malformed wallclock ns field instead of aborting the whole run', async () => {
    // Before the fix, BigInt('1.5') threw out of the ingest transaction and
    // discarded the ENTIRE run's history. Now the bad field is treated as
    // absent and the run stores.
    const org = await seedOrg(db, 'ingest-wc')
    const s = summary({
      runId: 'run-wc',
      workspaceId: 'wc',
      tasks: [
        task({
          project: 'a',
          task: 'good',
          wallclockStartNs: '1000000',
          wallclockEndNs: '2000000',
        }),
        task({ project: 'a', task: 'bad', wallclockStartNs: '1.5', wallclockEndNs: 'NaN' }),
      ],
    })
    const res = await analytics.ingest({ orgId: org, summary: s })
    expect(res.stored).toBe(true)
    const rows = await db.sql<{ task: string; wallclock_start_ns: string | null }[]>`
      SELECT task, wallclock_start_ns FROM task_runs
      WHERE run_id = ${'run-wc'} ORDER BY task`
    expect(rows.map((r) => r.task)).toEqual(['bad', 'good'])
    // The malformed field is stored NULL; the well-formed sibling survives.
    expect(rows.find((r) => r.task === 'bad')!.wallclock_start_ns).toBeNull()
    expect(rows.find((r) => r.task === 'good')!.wallclock_start_ns).not.toBeNull()
  })

  it('getRunHeatmap buckets by UTC, not the server local timezone', async () => {
    const origTz = process.env.TZ
    process.env.TZ = 'America/New_York' // UTC-5: local hour/day differ from UTC
    try {
      // A recent instant at 03:00 UTC (inside the 30-day window); under EST
      // that is 22:00 the PREVIOUS day, so UTC and local day+hour both differ.
      const inst = new Date()
      inst.setUTCHours(3, 0, 0, 0)
      inst.setUTCDate(inst.getUTCDate() - 2)
      const ts = inst.getTime()
      const org = await seedOrg(db, 'heatmap-tz')
      const res = await analytics.ingest({
        orgId: org,
        summary: summary({ runId: 'run-hm', workspaceId: 'hm', startedAt: ts }),
      })
      const grid = await analytics.getRunHeatmap(res.workspaceId, 30)
      // The run lands in the UTC (day, hour=3) cell...
      const utcCell = grid.find((c) => c.dayOfWeek === inst.getUTCDay() && c.hourOfDay === 3)!
      expect(utcCell.runs).toBeGreaterThan(0)
      // ...and NOT in the local (22:00) cell — proving UTC bucketing.
      const localCell = grid.find(
        (c) => c.dayOfWeek === new Date(ts).getDay() && c.hourOfDay === 22,
      )!
      expect(localCell.runs).toBe(0)
    } finally {
      if (origTz === undefined) delete process.env.TZ
      else process.env.TZ = origTz
    }
  })

  it('reuses the workspace for a second push with the same client workspaceId', async () => {
    const org = await seedOrg(db, 'ingest-reuse')
    const a = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'same', runId: 'r1' }),
    })
    const b = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'same', runId: 'r2' }),
    })
    expect(b.workspaceId).toBe(a.workspaceId)
    const ws = await db.sql<
      { c: number }[]
    >`SELECT count(*)::int AS c FROM workspaces WHERE org_id = ${org}`
    expect(ws[0]!.c).toBe(1)
  })

  it('isolates a second client workspaceId into its own workspace', async () => {
    const org = await seedOrg(db, 'ingest-two')
    const a = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'one', workspaceName: 'one', runId: 'r1' }),
    })
    const b = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'two', workspaceName: 'two', runId: 'r2' }),
    })
    expect(a.workspaceId).not.toBe(b.workspaceId)
    const ws = await db.sql<
      { c: number }[]
    >`SELECT count(*)::int AS c FROM workspaces WHERE org_id = ${org}`
    expect(ws[0]!.c).toBe(2)
    // Each workspace sees only its own run.
    const aRows = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM invocations WHERE workspace_id = ${a.workspaceId}`
    expect(aRows[0]!.c).toBe(1)
  })

  it('dedupes slugs across two client ids with the same workspace name', async () => {
    const org = await seedOrg(db, 'ingest-slug')
    await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'c1', workspaceName: 'Repo', runId: 'r1' }),
    })
    await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'c2', workspaceName: 'Repo', runId: 'r2' }),
    })
    const slugs = await db.sql<{ slug: string }[]>`
      SELECT slug FROM workspaces WHERE org_id = ${org} ORDER BY slug`
    expect(slugs.map((s) => s.slug)).toEqual(['repo', 'repo-2'])
  })

  it('persists fingerprints for a --verify run, idempotent per platform', async () => {
    const org = await seedOrg(db, 'ingest-fp')
    const t = task({
      project: 'app',
      task: 'build',
      hash: 'fphash',
      outputFp: {
        tree: 'tree-linux',
        fileCount: 2,
        files: [
          ['dist/a.js', 'oid1'],
          ['dist/b.js', 'oid2'],
        ],
        truncated: false,
      },
    })
    const res = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'fpws', runId: 'r1', tasks: [t], os: 'linux', arch: 'x64' }),
    })
    const fps = await db.sql<{ hash: string; os: string; tree: string; file_count: number }[]>`
      SELECT hash, os, tree, file_count FROM output_fingerprints WHERE workspace_id = ${res.workspaceId}`
    expect(fps).toHaveLength(1)
    expect(fps[0]).toMatchObject({ hash: 'fphash', os: 'linux', tree: 'tree-linux', file_count: 2 })
    // Re-ingest under a different runId (idempotent PK) adds nothing.
    await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'fpws', runId: 'r2', tasks: [t], os: 'linux', arch: 'x64' }),
    })
    const again = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM output_fingerprints WHERE workspace_id = ${res.workspaceId}`
    expect(again[0]!.c).toBe(1)
  })

  it('skips aborted tasks', async () => {
    const org = await seedOrg(db, 'ingest-abort')
    const res = await analytics.ingest({
      orgId: org,
      summary: summary({
        workspaceId: 'abws',
        runId: 'r1',
        tasks: [
          task({ project: 'a', task: 'x' }),
          task({ project: 'a', task: 'y', status: 'aborted' }),
        ],
      }),
    })
    const trs = await db.sql<{ task: string }[]>`
      SELECT task FROM task_runs WHERE workspace_id = ${res.workspaceId} ORDER BY task`
    expect(trs.map((t) => t.task)).toEqual(['x'])
  })
})

describe('ingestTask (per-task incremental)', () => {
  const rowsFor = (ws: string, runId: string) =>
    db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM task_runs WHERE workspace_id = ${ws} AND run_id = ${runId}`

  it('inserts one task_run + its log, idempotently, and dedups against the batch', async () => {
    const org = await seedOrg(db, 'inc')
    const startedAt = Date.now()
    const t = task({
      project: 'app',
      task: 'build',
      status: 'success',
      wallclockStartNs: '0',
      wallclockEndNs: '500000000',
    })
    const record = {
      v: 1,
      runId: 'inc-r1',
      workspaceId: 'inc-ws',
      runStartedAt: startedAt,
      task: t,
      log: { content: 'building…\ndone\n', charsFull: 15, truncatedHeadChars: 0 },
    }
    const first = await analytics.ingestTask({ orgId: org, record })
    expect(first.stored).toBe(true)
    const ws = first.workspaceId
    expect((await rowsFor(ws, 'inc-r1'))[0]!.c).toBe(1)
    // The log landed and reads back.
    const log = await analytics.logFor(ws, 'inc-r1', 'app#build')
    expect(log?.content).toContain('done')

    // Idempotent: a re-delivery adds no row.
    await analytics.ingestTask({ orgId: org, record })
    expect((await rowsFor(ws, 'inc-r1'))[0]!.c).toBe(1)

    // The end-of-run batch, with the SAME run start + task, dedups (no dup).
    await analytics.ingest({
      orgId: org,
      summary: summary({ runId: 'inc-r1', workspaceId: 'inc-ws', startedAt, tasks: [t] }),
    })
    expect((await rowsFor(ws, 'inc-r1'))[0]!.c).toBe(1)
  })

  it('the batch backfills a task the incremental push never delivered', async () => {
    const org = await seedOrg(db, 'inc-backfill')
    const startedAt = Date.now()
    const ran = task({ project: 'app', task: 'build', wallclockStartNs: '0', wallclockEndNs: '1' })
    const missed = task({
      project: 'app',
      task: 'test',
      wallclockStartNs: '0',
      wallclockEndNs: '2',
    })
    // Only 'build' arrives incrementally.
    const { workspaceId: ws } = await analytics.ingestTask({
      orgId: org,
      record: { v: 1, runId: 'bf-r1', workspaceId: 'bf-ws', runStartedAt: startedAt, task: ran },
    })
    expect((await rowsFor(ws, 'bf-r1'))[0]!.c).toBe(1)
    // The summary has BOTH; the batch backfills the dropped 'test'.
    await analytics.ingest({
      orgId: org,
      summary: summary({ runId: 'bf-r1', workspaceId: 'bf-ws', startedAt, tasks: [ran, missed] }),
    })
    const tasks = await db.sql<{ task: string }[]>`
      SELECT task FROM task_runs WHERE workspace_id = ${ws} AND run_id = 'bf-r1' ORDER BY task`
    expect(tasks.map((t) => t.task)).toEqual(['build', 'test'])
  })

  it('an aborted task stores nothing but still routes the workspace', async () => {
    const org = await seedOrg(db, 'inc-abort')
    const startedAt = Date.now()
    const res = await analytics.ingestTask({
      orgId: org,
      record: {
        v: 1,
        runId: 'ab-r1',
        workspaceId: 'ab-ws',
        runStartedAt: startedAt,
        task: task({ project: 'a', task: 'x', status: 'aborted' }),
      },
    })
    expect(res.stored).toBe(false)
    expect((await rowsFor(res.workspaceId, 'ab-r1'))[0]!.c).toBe(0)
  })
})

describe('workspace-scoped token routing', () => {
  it('maps a new client id to the token workspace, refuses a mismatch', async () => {
    const org = await seedOrg(db, 'scoped')
    const wsA = await seedWorkspace(db, org, 'a')
    const wsB = await seedWorkspace(db, org, 'b')
    // First push under a token scoped to wsA maps clientId → wsA.
    const res = await analytics.ingest({
      orgId: org,
      tokenWorkspaceId: wsA,
      summary: summary({ workspaceId: 'client-x', runId: 'r1' }),
    })
    expect(res.workspaceId).toBe(wsA)
    // A token scoped to wsB pushing the SAME clientId (already mapped to wsA)
    // is a cross-workspace write → 403.
    await expect(
      analytics.ingest({
        orgId: org,
        tokenWorkspaceId: wsB,
        summary: summary({ workspaceId: 'client-x', runId: 'r2' }),
      }),
    ).rejects.toBeInstanceOf(WorkspaceForbiddenError)
  })
})

describe('ingestLogs', () => {
  it('stores task-log tails and is idempotent per (run, task)', async () => {
    const org = await seedOrg(db, 'logs-1')
    const ws = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'lw', runId: 'run-logs' }),
    })
    const bundle: TaskLogBundle = {
      v: 1,
      runId: 'run-logs',
      workspaceId: 'lw',
      tasks: [
        {
          taskId: 'app#build',
          hash: 'h',
          status: 'failed',
          content: 'boom\n',
          charsFull: 5,
          truncatedHeadChars: 0,
        },
      ],
    }
    const first = await analytics.ingestLogs({ orgId: org, bundle })
    expect(first.stored).toBe(1)
    expect(first.workspaceId).toBe(ws.workspaceId)
    const rows = await db.sql<{ status: string; content: Uint8Array; codec: string }[]>`
      SELECT status, content, codec FROM task_logs WHERE workspace_id = ${ws.workspaceId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.codec).toBe('plain')
    expect(Buffer.from(rows[0]!.content).toString('utf8')).toBe('boom\n')
    // Re-delivery adds nothing.
    const second = await analytics.ingestLogs({ orgId: org, bundle })
    expect(second.stored).toBe(0)
  })
})

describe('ingestCatalog', () => {
  it('upserts projects + tasks with config; name-only ingest never clobbers config', async () => {
    const org = await seedOrg(db, 'catalog-1')
    // A run first provisions the task name-only (no config).
    const ing = await analytics.ingest({
      orgId: org,
      summary: summary({
        workspaceId: 'cw',
        runId: 'r1',
        tasks: [task({ project: 'app', task: 'build' })],
      }),
    })
    // Then a catalog push enriches it.
    const cat = await analytics.ingestCatalog({
      orgId: org,
      push: {
        v: 1,
        workspaceId: 'cw',
        projects: [
          {
            name: 'app',
            tasks: [
              {
                task: 'build',
                config: { exec: { command: 'tsc' } },
                cacheable: true,
                isGroup: false,
                persistent: false,
              },
            ],
          },
        ],
      },
    })
    expect(cat.workspaceId).toBe(ing.workspaceId)
    const rows = await db.sql<{ task: string; cacheable: boolean; config: unknown }[]>`
      SELECT pt.task, pt.cacheable, pt.config FROM project_tasks pt
      JOIN projects p ON p.id = pt.project_id WHERE p.workspace_id = ${ing.workspaceId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cacheable).toBe(true)
    // config is stored as proper jsonb (an object), so Bun.sql reads it back
    // as an object — no double-encoded string to JSON.parse.
    expect(rows[0]!.config).toEqual({ exec: { command: 'tsc' } })

    // A subsequent name-only run must NOT wipe the config the catalog set.
    await analytics.ingest({
      orgId: org,
      summary: summary({
        workspaceId: 'cw',
        runId: 'r2',
        tasks: [task({ project: 'app', task: 'build' })],
      }),
    })
    const after = await db.sql<{ config: unknown }[]>`
      SELECT pt.config FROM project_tasks pt
      JOIN projects p ON p.id = pt.project_id WHERE p.workspace_id = ${ing.workspaceId}`
    expect(after[0]!.config).toEqual({ exec: { command: 'tsc' } })
  })
})

describe('workspace selection', () => {
  it('resolveReadWorkspace clamps ?ws= to the org and 404s a foreign id', async () => {
    const org = await seedOrg(db, 'sel-1')
    const otherOrg = await seedOrg(db, 'sel-other')
    const res = await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'w', runId: 'r1' }),
    })
    const foreign = await seedWorkspace(db, otherOrg, 'foreign')

    expect(await analytics.resolveReadWorkspace(org, res.workspaceId)).toBe(res.workspaceId)
    expect(await analytics.resolveReadWorkspace(org, foreign)).toBeNull()
    expect(await analytics.resolveReadWorkspace(org, 'not-a-uuid')).toBeNull()
    // No param → the sole workspace.
    expect(await analytics.resolveReadWorkspace(org)).toBe(res.workspaceId)
  })

  it('workspacesForOrg + count reflect only the org', async () => {
    const org = await seedOrg(db, 'sel-count')
    await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'a', workspaceName: 'A', runId: 'r1' }),
    })
    await analytics.ingest({
      orgId: org,
      summary: summary({ workspaceId: 'b', workspaceName: 'B', runId: 'r2' }),
    })
    expect(await analytics.workspaceCount(org)).toBe(2)
    const list = await analytics.workspacesForOrg(org)
    expect(list).toHaveLength(2)
    expect(list.every((w) => w.runCount === 1)).toBe(true)
    expect(new Set(list.map((w) => w.name))).toEqual(new Set(['A', 'B']))
  })
})

describe('security-review regressions', () => {
  it('jsonb tags/requestedTasks store as objects — the @> tag filter matches a multi-tag run', async () => {
    const org = await seedOrg(db, 'jsonb-1')
    const s = summary({ workspaceId: 'jw1', workspaceName: 'jsonb/app', runId: 'jr1' })
    s.run.tags = { team: 'core', env: 'prod' }
    s.run.requestedTasks = ['build', 'test']
    const { workspaceId } = await analytics.ingest({ orgId: org, summary: s })

    // Stored as a jsonb OBJECT, not a double-encoded string scalar.
    const raw = await db.sql<{ ty: string }[]>`
      SELECT jsonb_typeof(tags) AS ty FROM invocations WHERE run_id = ${'jr1'}`
    expect(raw[0]!.ty).toBe('object')

    // The @> containment filter matches a run carrying the tag among others.
    expect(
      await analytics.listInvocations(workspaceId, { tagKey: 'team', tagValue: 'core' }),
    ).toHaveLength(1)
    expect(
      await analytics.listInvocations(workspaceId, { tagKey: 'env', tagValue: 'prod' }),
    ).toHaveLength(1)
    expect(
      await analytics.listInvocations(workspaceId, { tagKey: 'team', tagValue: 'nope' }),
    ).toHaveLength(0)

    // Reads round-trip as objects/arrays.
    const inv = await analytics.getInvocation(workspaceId, 'jr1')
    expect(inv!.tags).toEqual({ team: 'core', env: 'prod' })
    expect(inv!.requestedTasks).toEqual(['build', 'test'])
  })

  it('concurrent first-push of one new workspace: all land, exactly one workspace', async () => {
    const org = await seedOrg(db, 'race-1')
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        analytics.ingest({
          orgId: org,
          summary: summary({
            workspaceId: 'shared-ws',
            workspaceName: 'race/app',
            runId: `rr${i}`,
          }),
        }),
      ),
    )
    // Every push stored (none rejected with a lost run).
    expect(results.filter((r) => r.stored)).toHaveLength(6)
    // All converged to ONE workspace.
    expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1)
    const ws = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM workspaces WHERE org_id = ${org}`
    expect(Number(ws[0]!.n)).toBe(1)
    const invs = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invocations WHERE workspace_id = ${results[0]!.workspaceId}`
    expect(Number(invs[0]!.n)).toBe(6)
  })
})
