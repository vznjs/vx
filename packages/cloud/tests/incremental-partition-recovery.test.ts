import { describe, expect, it } from 'bun:test'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics, type TaskIngestRecord } from '../src/db/analytics.js'
import { maintainPartitions } from '../src/db/partitions.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

async function seedOrg(db: DbClient, slug: string): Promise<string> {
  const orgId = Bun.randomUUIDv7()
  await db.sql`INSERT INTO organizations (id, slug, name, created_at)
               VALUES (${orgId}, ${slug}, ${slug}, ${Date.now()})`
  return orgId
}

function task(project: string, t: string): TaskTelemetry {
  return {
    taskId: `${project}#${t}`,
    project,
    task: t,
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 100,
    hash: 'h0',
    wallclockStartNs: '1000000',
    wallclockEndNs: '101000000',
  }
}
function summary(startedAt: number, runId: string, tasks: TaskTelemetry[]): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0',
      command: 'vx run',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: 'broad',
      workspaceId: 'wshash1',
      workspaceName: 'acme/app',
      commitSha: 'a',
      branch: 'main',
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'gh',
      host: 'r',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt,
    endedAt: startedAt + 500,
    totalDurationMs: 500,
    taskCount: tasks.length,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks,
  }
}
const inc = (runStartedAt: number, runId: string, t: TaskTelemetry): TaskIngestRecord => ({
  v: 1,
  runId,
  workspaceId: 'wshash1',
  workspaceName: 'acme/app',
  runStartedAt,
  task: t,
})

describe('production maintainPartitions recovery with the unique index', () => {
  it('a DEFAULT-resident incremental row survives maintainPartitions creating its partition, and dedups', async () => {
    const pg = await ephemeralPg()
    const db = openDb(await pg.createDatabase())
    const a = new Analytics(db.sql)
    const org = await seedOrg(db, 'rec-a')
    // No maintainPartitions yet → only DEFAULT exists → this row lands in DEFAULT.
    const startedAt = Date.now()
    const runId = Bun.randomUUIDv7()
    const t = task('app', 'build')
    await a.ingestTask({ orgId: org, record: inc(startedAt, runId, t) })
    const inDefault0 = (
      await db.sql<
        { c: number }[]
      >`SELECT count(*)::int AS c FROM task_runs_default WHERE run_id=${runId}`
    )[0]!.c
    expect(inDefault0).toBe(1) // confirm it really is in DEFAULT

    // Production maintenance: create the covering partition. This MUST hit the
    // DEFAULT-collision recovery (detach/create/move/reattach) — and must NOT throw.
    const warnings: string[] = []
    await maintainPartitions(db, {
      now: startedAt,
      retentionDays: 180,
      warn: (m) => warnings.push(m),
    })
    expect(warnings).toEqual([]) // recovery succeeded, nothing degraded to DEFAULT

    const inDefault1 = (
      await db.sql<
        { c: number }[]
      >`SELECT count(*)::int AS c FROM task_runs_default WHERE run_id=${runId}`
    )[0]!.c
    const total1 = (
      await db.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM task_runs WHERE run_id=${runId}`
    )[0]!.c
    expect(total1).toBe(1) // row preserved
    expect(inDefault1).toBe(0) // moved OUT of default into the real partition

    // The batch backstop re-inserts the same task → dedup must still hold across
    // the newly-created real partition.
    await a.ingest({ orgId: org, summary: summary(startedAt, runId, [t]) })
    const total2 = (
      await db.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM task_runs WHERE run_id=${runId}`
    )[0]!.c
    expect(total2).toBe(1)
    await db.close()
  })
})
