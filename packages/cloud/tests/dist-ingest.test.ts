// The distributed controller records the run into Postgres analytics
// (dist-run-history-2026-07): a REAL DistScheduler + REAL Analytics on ephemeral
// pg, driven across a fake agent + a store prune hit, then READ BACK through the
// same analytics queries the dashboard uses. Proves the run lands under Runs
// with the right tallies, task_runs carry the right cache_hit/status, run_id ==
// submissionId, and the live `taskDone` rows + the end-of-run `runFinished`
// backstop dedup (N rows, never 2N — the idempotency guarantee).

import { beforeAll, describe, expect, it } from 'bun:test'
import type { OutcomeView, RunSummaryRecord, TaskView } from '@vzn/vx'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics } from '../src/db/analytics.js'
import { AgentRegistry, type RegisteredAgent } from '../src/dist/registry.js'
import { makeDistRunRecorder } from '../src/dist/dist-recorder.js'
import { DistScheduler, type ArtifactProbe, type DistRunRecorder } from '../src/dist/scheduler.js'
import {
  DIST_PROTOCOL_VERSION,
  type AgentHello,
  type DistGraphNode,
  type DistServerMessage,
  type DistSubmitContext,
  type DistSubmitMessage,
} from '../src/protocol-dist.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

const CLIENT_WS = '00112233aabbccdd'
const COMMIT = 'deadbeefcafef00d'

function view(id: string): TaskView {
  const [project, task] = id.split('#') as [string, string]
  return { id, project, task, isGroup: false, requested: true, surfaced: false, persistent: false }
}

function node(id: string, deps: string[] = [], stableHash?: string): DistGraphNode {
  return { id, deps, view: view(id), ...(stableHash !== undefined ? { stableHash } : {}) }
}

const context: DistSubmitContext = {
  os: 'linux',
  arch: 'x64',
  host: 'ci-runner-7',
  ci: true,
  ciProvider: 'github',
  vxVersion: '9.9.9',
  dirty: false,
  workspaceName: 'acme-monorepo',
}

/** Drive the scheduler + a fake agent to completion; return the submissionId +
 *  the summary the controller recorded. Uses the REAL registry + REAL recorder. */
async function runControlled(
  analytics: Analytics,
  orgId: string,
  nodes: DistGraphNode[],
  store: ArtifactProbe,
  logs: Record<string, string> = {},
): Promise<{ submissionId: string; summary: RunSummaryRecord }> {
  const submissionId = Bun.randomUUIDv7()
  const submit: DistSubmitMessage = {
    t: 'dist:submit',
    protocol: DIST_PROTOCOL_VERSION,
    session: 'sess',
    workspaceId: CLIENT_WS,
    submissionId,
    commitSha: COMMIT,
    branch: 'main',
    defaultBranch: 'main',
    context,
    expectedAgents: 1,
    agentTimeoutMs: 60_000,
    request: {
      tasks: ['build'],
      cwd: '/w',
      command: 'vx run build --all',
      concurrency: 4,
      flow: 'broad',
    },
    nodes,
  }

  // A wrapping recorder: delegate to the REAL makeDistRunRecorder AND capture the
  // summary for the explicit re-ingest idempotency check.
  const inner = makeDistRunRecorder(analytics, { orgId }, () => {})
  let captured: RunSummaryRecord | undefined
  const recorder: DistRunRecorder = {
    taskDone: (r) => inner.taskDone(r),
    runFinished: (s) => {
      captured = s
      inner.runFinished(s)
    },
  }

  const reg = new AgentRegistry()
  const pending: Array<{ taskId: string; submissionId: string }> = []
  let handle: RegisteredAgent = undefined as unknown as RegisteredAgent
  const io = {
    send: (m: DistServerMessage) => {
      if (m.t === 'task:assign') pending.push({ taskId: m.taskId, submissionId: m.submissionId })
    },
    close: () => {},
  }
  const hello: AgentHello = {
    t: 'agent:hello',
    protocol: DIST_PROTOCOL_VERSION,
    agentId: 'agent-1',
    workspaceId: CLIENT_WS,
    session: 'sess',
    commitSha: COMMIT,
    capacity: 4,
  }
  handle = reg.hello(hello, io, orgId) as RegisteredAgent

  const sched = new DistScheduler({ submit, store, send: () => {}, recorder })
  const bound = reg.beginSubmission(CLIENT_WS, 'sess', sched, orgId)
  if ('error' in bound) throw new Error(bound.error)
  sched.attach(bound)
  await sched.start()

  // Complete every dispatched assignment as a real agent would (start →
  // stream its task's stdout → done). The agent tees its scoped run's task
  // stream to the controller as `agent:stdout`, so injecting one here is
  // exactly what a real executed task produces.
  for (let guard = 0; pending.length > 0 && guard < 100; guard++) {
    const next = pending.shift()!
    reg.dispatch(handle, { t: 'agent:start', taskId: next.taskId, submissionId: next.submissionId })
    const chunk = logs[next.taskId]
    if (chunk !== undefined) {
      reg.dispatch(handle, {
        t: 'agent:stdout',
        taskId: next.taskId,
        submissionId: next.submissionId,
        chunk,
      })
    }
    reg.dispatch(handle, {
      t: 'agent:done',
      taskId: next.taskId,
      submissionId: next.submissionId,
      outcome: {
        taskId: next.taskId,
        status: 'success',
        exitCode: 0,
        durationMs: 120,
        hash: `h-${next.taskId}`,
        cpuMs: 90,
      } satisfies OutcomeView,
    })
  }

  await sched.done
  return { submissionId, summary: captured! }
}

/** Poll until `cond` returns a value, or throw after the deadline. */
async function until<T>(cond: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const v = await cond()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

let db: DbClient
let analytics: Analytics

beforeAll(async () => {
  const pg = await ephemeralPg()
  db = openDb(await pg.createDatabase())
  analytics = new Analytics(db.sql)
})

describe('distributed controller records the run into Postgres analytics', () => {
  it('records the run + tasks with correct tallies/cacheSource; run_id == submissionId; idempotent', async () => {
    const org = Bun.randomUUIDv7()
    await db.sql`INSERT INTO organizations (id, slug, name, created_at)
                 VALUES (${org}, ${'o-dist-' + org.slice(0, 8)}, ${'dist'}, ${Date.now()})`

    // Two tasks: lib#build is a STORE prune hit (cache-hit-remote); app#build
    // depends on it and executes on the agent (success).
    const store: ArtifactProbe = {
      has: (h) => Promise.resolve(h === 'stable-lib'),
      storedDurationMs: (h) => Promise.resolve(h === 'stable-lib' ? 250 : undefined),
    }
    const nodes = [node('lib#build', [], 'stable-lib'), node('app#build', ['lib#build'])]

    const { submissionId, summary } = await runControlled(analytics, org, nodes, store)

    // The controller-assembled summary tallies (shared core builder).
    expect(summary.run.runId).toBe(submissionId)
    expect(summary.taskCount).toBe(2)
    expect(summary.failedCount).toBe(0)
    expect(summary.hitCount).toBe(1)
    expect(summary.hitRemoteCount).toBe(1)
    expect(summary.exitOk).toBe(true)
    // Submitter context reached the invocation header.
    expect(summary.run.workspaceId).toBe(CLIENT_WS)
    expect(summary.run.os).toBe('linux')
    expect(summary.run.ci).toBe(true)

    // The run is routed to a server workspace + fills in (fire-and-forget writes).
    const ws = await until(
      () => analytics.resolveClientWorkspace(org, CLIENT_WS).then((w) => w ?? undefined),
      'workspace provisioning',
    )
    const runs = await until(async () => {
      const rows = await analytics.listRuns(ws, { runId: submissionId })
      return rows.length === 2 ? rows : undefined
    }, 'both task_runs')

    // Exactly TWO task_runs — the live `taskDone` rows and the `runFinished`
    // backstop deduped (never 4). This is the idempotency guarantee.
    expect(runs).toHaveLength(2)
    const byTask = new Map(runs.map((r) => [`${r.project}#${r.task}`, r]))
    expect(byTask.get('lib#build')!.cacheHit).toBe(true)
    expect(byTask.get('lib#build')!.status).toBe('cache-hit-remote')
    expect(byTask.get('app#build')!.cacheHit).toBe(false)
    expect(byTask.get('app#build')!.status).toBe('success')
    for (const r of runs) expect(r.runId).toBe(submissionId)

    // The invocation header appears under Runs with the assembled tallies.
    const inv = await until(async () => {
      const list = await analytics.listInvocations(ws)
      return list.find((i) => i.runId === submissionId)
    }, 'invocation header')
    expect(inv.taskCount).toBe(2)
    expect(inv.failedCount).toBe(0)
    expect(inv.hitCount).toBe(1)
    expect(inv.exitOk).toBe(true)
    expect(inv.ci).toBe(true)
    expect(inv.os).toBe('linux')
    expect(inv.commitSha).toBe(COMMIT)
    expect(inv.command).toBe('vx run build --all')

    // Re-deriving the header ingest is idempotent — no duplicate task_runs.
    const before = (await analytics.listRuns(ws, { runId: submissionId })).length
    await analytics.ingest({ orgId: org, summary })
    const after = (await analytics.listRuns(ws, { runId: submissionId })).length
    expect(after).toBe(before)
  })

  it("captures each executed task's log tail into task_logs; a hit stores none", async () => {
    const org = Bun.randomUUIDv7()
    await db.sql`INSERT INTO organizations (id, slug, name, created_at)
                 VALUES (${org}, ${'o-logs-' + org.slice(0, 8)}, ${'logs'}, ${Date.now()})`

    // lib#build is a STORE prune hit (never executes on an agent → no stream);
    // app#build executes and streams its output.
    const store: ArtifactProbe = {
      has: (h) => Promise.resolve(h === 'stable-lib'),
      storedDurationMs: (h) => Promise.resolve(h === 'stable-lib' ? 250 : undefined),
    }
    const nodes = [node('lib#build', [], 'stable-lib'), node('app#build', ['lib#build'])]
    const appOutput = 'compiling app…\nbundled 42 modules\n✓ done\n'

    const { submissionId } = await runControlled(analytics, org, nodes, store, {
      'app#build': appOutput,
    })

    const ws = await until(
      () => analytics.resolveClientWorkspace(org, CLIENT_WS).then((w) => w ?? undefined),
      'workspace provisioning',
    )
    // Wait for both task_runs to land (the recorder writes are fire-and-forget).
    await until(async () => {
      const rows = await analytics.listRuns(ws, { runId: submissionId })
      return rows.length === 2 ? rows : undefined
    }, 'both task_runs')

    // The executed task's log tail reads back through the dashboard's query.
    const appLog = await until(
      () => analytics.logFor(ws, submissionId, 'app#build').then((l) => l ?? undefined),
      'app#build log',
    )
    expect(appLog.content).toBe(appOutput)
    expect(appLog.charsFull).toBe(appOutput.length)
    expect(appLog.truncatedHeadChars).toBe(0)
    expect(appLog.status).toBe('success')

    // A store prune hit stores no log tail — the executed run that produced it
    // already holds the bytes (a hit resolves by hash).
    expect(await analytics.logFor(ws, submissionId, 'lib#build')).toBeUndefined()
  })

  it('a scheduler with NO recorder writes nothing (byte-identical to before)', async () => {
    const org = Bun.randomUUIDv7()
    await db.sql`INSERT INTO organizations (id, slug, name, created_at)
                 VALUES (${org}, ${'o-norec-' + org.slice(0, 8)}, ${'norec'}, ${Date.now()})`
    const client = 'ffeeddccbbaa9988'
    const submissionId = Bun.randomUUIDv7()
    const store: ArtifactProbe = {
      has: (h) => Promise.resolve(h === 'only'),
      storedDurationMs: () => Promise.resolve(10),
    }
    const submit: DistSubmitMessage = {
      t: 'dist:submit',
      protocol: DIST_PROTOCOL_VERSION,
      session: 'sess2',
      workspaceId: client,
      submissionId,
      commitSha: COMMIT,
      expectedAgents: 0,
      agentTimeoutMs: 60_000,
      request: { tasks: ['build'], cwd: '/w' },
      nodes: [node('lib#build', [], 'only')],
    }
    const reg = new AgentRegistry()
    const sched = new DistScheduler({ submit, store, send: () => {} })
    const bound = reg.beginSubmission(client, 'sess2', sched, org)
    if ('error' in bound) throw new Error(bound.error)
    sched.attach(bound)
    await sched.start()
    expect(await sched.done).toEqual({ ok: true })
    // Nothing was routed/recorded — no workspace ever provisioned for this org.
    expect(await analytics.resolveClientWorkspace(org, client)).toBeNull()
  })
})
