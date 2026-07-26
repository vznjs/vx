// Deleting a workspace is REAL data loss: it is the root every analytics row
// hangs off. This drives the whole thing through the real wire — a run and its
// task log pushed by a ci token, then the admin DELETE — and asserts both that
// the history is unreachable AND that the rows are actually gone.
//
// The row-level assertion is the discriminating one: `invocations`, `task_runs`
// and `task_logs` are RANGE-partitioned and carry `workspace_id` with NO
// foreign key, so nothing cascades to them. A delete that only dropped the
// `workspaces` row would still pass every HTTP check (an unknown `?ws=` 404s)
// while leaving the history orphaned in the database forever.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0)

function summary(wsId: string, wsName: string, runId: string, project: string) {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '1.4.2',
      command: 'vx run ci',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: wsId,
      workspaceName: wsName,
      commitSha: 'a'.repeat(40),
      branch: 'main',
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'runner-01',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: NOW,
    endedAt: NOW + 500,
    totalDurationMs: 500,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        project,
        task: 'build',
        status: 'success',
        durationMs: 500,
        exitCode: 0,
        cacheSource: 'miss',
        hash: 'h1',
        attempts: 1,
      },
    ],
  }
}

function logBundle(wsId: string, runId: string, project: string) {
  return {
    v: 1,
    runId,
    workspaceId: wsId,
    tasks: [
      {
        taskId: `${project}#build`,
        hash: 'h1',
        status: 'success',
        content: 'compiled ok\n',
        charsFull: 12,
        truncatedHeadChars: 0,
      },
    ],
  }
}

describe('workspace lifecycle (rename + delete over the real wire)', () => {
  let p: TestPlatform
  let db: DbClient

  const asSession = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${p.origin}${path}`, {
      method,
      headers: {
        cookie: `vx_session=${p.cookie}`,
        'x-vx-csrf': '1',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const push = async (path: string, body: unknown): Promise<void> => {
    const r = await fetch(`${p.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.ciToken}` },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`)
  }

  const workspaces = async (): Promise<{ id: string; name: string }[]> => {
    const r = await asSession('GET', '/v1/workspaces')
    return ((await r.json()) as { workspaces: { id: string; name: string }[] }).workspaces
  }

  const countFor = async (table: string, wsId: string): Promise<number> => {
    // The table name is a literal from this file (never user input) and rides
    // in as a raw fragment; the workspace id stays a bound parameter.
    const rows = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM ${db.sql.unsafe(table)} WHERE workspace_id = ${wsId}`
    return rows[0]!.c
  }

  beforeAll(async () => {
    p = await bootPlatform({ bucket: 'ws-lifecycle' })
    db = openDb(p.dbUrl)
    await push('/v1/ingest', summary('client-doomed', 'doomed-repo', 'run-doomed', 'checkout'))
    await push('/v1/ingest/logs', logBundle('client-doomed', 'run-doomed', 'checkout'))
    await push('/v1/ingest', summary('client-keep', 'keeper-repo', 'run-keep', 'billing'))
    await push('/v1/ingest/logs', logBundle('client-keep', 'run-keep', 'billing'))
  }, 120_000)

  afterAll(async () => {
    await db?.close()
    await p?.stop()
  }, 120_000)

  it('renames an auto-provisioned workspace, and the rename survives the next push', async () => {
    const before = (await workspaces()).find((w) => w.name === 'keeper-repo')!
    const patched = await asSession('PATCH', `/v1/admin/orgs/${p.orgId}/workspaces/${before.id}`, {
      name: 'Billing Platform',
      slug: 'billing-platform',
    })
    expect(patched.status).toBe(200)
    expect((await workspaces()).find((w) => w.id === before.id)?.name).toBe('Billing Platform')

    // The client keeps pushing under its own (unchanged) workspaceName —
    // routeWorkspace sets `name` only on the first-push INSERT, so the rename
    // must not be clobbered.
    await push('/v1/ingest', summary('client-keep', 'keeper-repo', 'run-keep-2', 'billing'))
    expect((await workspaces()).find((w) => w.id === before.id)?.name).toBe('Billing Platform')
  })

  it('deletes a workspace and its ENTIRE history — rows gone, not just hidden', async () => {
    const doomed = (await workspaces()).find((w) => w.name === 'doomed-repo')!
    const keeper = (await workspaces()).find((w) => w.name === 'Billing Platform')!

    // The history is there and readable before the delete.
    const runsBefore = await asSession('GET', `/v1/runs?ws=${doomed.id}`)
    expect(runsBefore.status).toBe(200)
    const { runs } = (await runsBefore.json()) as { runs: { runId: string | null }[] }
    expect(runs.some((r) => r.runId === 'run-doomed')).toBe(true)
    expect(await countFor('invocations', doomed.id)).toBe(1)
    expect(await countFor('task_runs', doomed.id)).toBe(1)
    expect(await countFor('task_logs', doomed.id)).toBe(1)
    expect(await countFor('projects', doomed.id)).toBe(1)
    expect(await countFor('repos', doomed.id)).toBe(1)

    const del = await asSession('DELETE', `/v1/admin/orgs/${p.orgId}/workspaces/${doomed.id}`, {
      confirm: 'doomed-repo',
    })
    expect(del.status).toBe(200)

    // Unreachable…
    expect((await workspaces()).some((w) => w.id === doomed.id)).toBe(false)
    expect((await asSession('GET', `/v1/runs?ws=${doomed.id}`)).status).toBe(404)
    // …and actually gone, across every table that carries the workspace id.
    expect(await countFor('invocations', doomed.id)).toBe(0)
    expect(await countFor('task_runs', doomed.id)).toBe(0)
    expect(await countFor('task_logs', doomed.id)).toBe(0)
    expect(await countFor('projects', doomed.id)).toBe(0)
    expect(await countFor('repos', doomed.id)).toBe(0)

    // The sibling workspace is untouched — the delete is workspace-scoped, not
    // an org-wide wipe.
    expect(await countFor('invocations', keeper.id)).toBe(2)
    expect(await countFor('task_logs', keeper.id)).toBe(1)
    const keeperRuns = await asSession('GET', `/v1/runs?ws=${keeper.id}`)
    expect(keeperRuns.status).toBe(200)
    const kept = (await keeperRuns.json()) as { runs: { runId: string | null }[] }
    expect(kept.runs.some((r) => r.runId === 'run-keep')).toBe(true)
  })

  it('a deleted workspace id is re-provisioned fresh on the next push', async () => {
    // The repo row cascaded away with the workspace, so the same client id
    // resolves to a NEW workspace instead of resurrecting the old one.
    await push('/v1/ingest', summary('client-doomed', 'doomed-repo', 'run-again', 'checkout'))
    const again = (await workspaces()).find((w) => w.name === 'doomed-repo')!
    expect(again).toBeDefined()
    expect(await countFor('invocations', again.id)).toBe(1)
  })
})
