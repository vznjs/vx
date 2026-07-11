// The Postgres analytics store (docs/design/cloud-platform-2026-07.md §5.4-5.6)
// — the org/workspace-clamped port of core's `src/orchestrator/metrics.ts`.
//
// This is a DELIBERATE dialect fork: core's metrics.ts stays untouched (it
// serves the LOCAL bun:sqlite cache.db for `vx mcp`/`vx info`); this file is
// the multi-tenant Postgres half. Response shapes MUST stay byte-identical to
// core's — the dashboard reads both through the same wire contract — but the
// metrics response TYPES aren't on the `@vzn/vx` façade (only the query
// functions are), so the shapes are MIRRORED here and kept in lockstep by the
// seeded pinned tests (analytics-read.test.ts). The known drift traps the
// decision log names (periodStats NULL folding, the regressions tiebreaker,
// half-open windows) are carried over.
//
// Every read takes (orgId, workspaceId) and filters by workspace_id — the
// tenant clamp is structural, a caller can never read across the boundary.
// Every write routes the pushed client workspaceId to a server workspace
// (§5.5) and auto-provisions on first push.

import type { SQL } from 'bun'
import type { OutputFingerprint, RunSummaryRecord } from '@vzn/vx'
import {
  RUN_LOG_BUDGET_CHARS,
  TASK_LOG_TAIL_CHARS,
  type TaskLogBundle,
} from '../task-log-capture.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Server-side per-file fingerprint cap, re-applied regardless of the wire claim. */
export const FP_MAX_FILES = 500

/** A log/fp blob at/over this many bytes is stored zstd-compressed. */
const COMPRESS_THRESHOLD_BYTES = 4 * 1024

/**
 * A workspace-scoped token tried to write history that resolves to a DIFFERENT
 * workspace — a 403. Never a data-shape error; the route maps it to a status.
 */
export class WorkspaceForbiddenError extends Error {
  readonly status = 403
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceForbiddenError'
  }
}

export interface WorkspaceEntry {
  id: string
  name: string
  slug: string
  lastSeenAt: number
  runCount: number
}

/** The lock-derived catalog push (§5.6) — one project + its resolved tasks. */
export interface CatalogPushTask {
  task: string
  config?: unknown
  cacheable?: boolean
  isGroup?: boolean
  persistent?: boolean
}
export interface CatalogPushProject {
  name: string
  tasks?: CatalogPushTask[]
}
export interface CatalogPush {
  v: 1
  workspaceId: string
  workspaceName?: string
  projects: CatalogPushProject[]
}

interface RouteArgs {
  orgId: string
  /** Set when the token is workspace-scoped — the summary MUST resolve here. */
  tokenWorkspaceId?: string | undefined
  clientWorkspaceId: string
  workspaceName: string
  now: number
}

function slugify(base: string): string {
  const s = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return s === '' ? 'workspace' : s
}

/** Validate + re-truncate a fingerprint's file map to FP_MAX_FILES (server-side). */
function normalizeFpFiles(
  files: ReadonlyArray<readonly [string, string]> | undefined,
  truncatedIn: boolean | undefined,
): { files: Array<[string, string]> | null; truncated: boolean } {
  if (files === undefined) return { files: null, truncated: truncatedIn === true }
  let list = files as ReadonlyArray<readonly [string, string]>
  let truncated = truncatedIn === true
  if (list.length > FP_MAX_FILES) {
    list = [...list].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, FP_MAX_FILES)
    truncated = true
  }
  return { files: list.map((p) => [p[0], p[1]] as [string, string]), truncated }
}

function isPairArray(v: unknown): v is ReadonlyArray<readonly [string, string]> {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string',
    )
  )
}

/** Structural validation of one fingerprint at the network boundary. */
function validFingerprint(fp: OutputFingerprint | undefined): fp is OutputFingerprint {
  if (fp === undefined) return false
  const f = fp as unknown as { tree?: unknown; fileCount?: unknown; files?: unknown }
  return (
    typeof f.tree === 'string' &&
    f.tree !== '' &&
    Number.isInteger(f.fileCount) &&
    (f.fileCount as number) >= 0 &&
    (f.files === undefined || isPairArray(f.files))
  )
}

export class Analytics {
  constructor(private readonly sql: SQL) {}

  // -------------------------------------------------------------------------
  // Ingest routing + auto-provision (§5.5)
  // -------------------------------------------------------------------------

  /**
   * Route a pushed client workspaceId to a server workspace within the token's
   * org, in its own small transaction (idempotent; the repos UNIQUE(org_id,
   * client_workspace_id) serializes concurrent first-pushes). Auto-provisions a
   * workspace + repo on first push (§5.5.2). A workspace-scoped token can never
   * resolve to another workspace — throws WorkspaceForbiddenError otherwise.
   */
  async routeWorkspace(args: RouteArgs): Promise<string> {
    return this.sql.begin(async (tx) => {
      const existing = await tx<{ workspace_id: string }[]>`
        SELECT workspace_id FROM repos
        WHERE org_id = ${args.orgId} AND client_workspace_id = ${args.clientWorkspaceId}`
      if (existing.length > 0) {
        const wsId = existing[0]!.workspace_id
        if (args.tokenWorkspaceId !== undefined && wsId !== args.tokenWorkspaceId) {
          throw new WorkspaceForbiddenError('token is scoped to a different workspace')
        }
        await tx`UPDATE repos SET last_seen_at = ${args.now}
                 WHERE org_id = ${args.orgId} AND client_workspace_id = ${args.clientWorkspaceId}`
        return wsId
      }

      // A workspace-scoped token maps its (new) client id to its OWN workspace
      // — it can only ever write there, so no cross-workspace risk.
      if (args.tokenWorkspaceId !== undefined) {
        const ws = await tx<{ id: string }[]>`
          SELECT id FROM workspaces WHERE id = ${args.tokenWorkspaceId} AND org_id = ${args.orgId}`
        if (ws.length === 0) {
          throw new WorkspaceForbiddenError('token workspace does not exist in this org')
        }
        await tx`INSERT INTO repos
            (id, org_id, workspace_id, client_workspace_id, remote_url, first_seen_at, last_seen_at)
          VALUES (${Bun.randomUUIDv7()}, ${args.orgId}, ${args.tokenWorkspaceId},
                  ${args.clientWorkspaceId}, ${args.workspaceName}, ${args.now}, ${args.now})
          ON CONFLICT (org_id, client_workspace_id) DO UPDATE SET last_seen_at = ${args.now}`
        return args.tokenWorkspaceId
      }

      // Org-scoped token, first push → auto-provision a workspace + repo.
      const slug = await this.uniqueSlug(tx, args.orgId, args.workspaceName)
      const wsId = Bun.randomUUIDv7()
      await tx`INSERT INTO workspaces (id, org_id, slug, name, created_at)
               VALUES (${wsId}, ${args.orgId}, ${slug}, ${args.workspaceName}, ${args.now})`
      const claimed = await tx<{ workspace_id: string }[]>`
        INSERT INTO repos
            (id, org_id, workspace_id, client_workspace_id, remote_url, first_seen_at, last_seen_at)
          VALUES (${Bun.randomUUIDv7()}, ${args.orgId}, ${wsId},
                  ${args.clientWorkspaceId}, ${args.workspaceName}, ${args.now}, ${args.now})
          ON CONFLICT (org_id, client_workspace_id) DO UPDATE SET last_seen_at = ${args.now}
          RETURNING workspace_id`
      const finalWs = claimed[0]!.workspace_id
      if (finalWs !== wsId) {
        // A concurrent first-push won the repo row; drop our orphan workspace.
        await tx`DELETE FROM workspaces WHERE id = ${wsId}`
      }
      return finalWs
    })
  }

  /** A slug unique within the org (`base`, then `base-2`, `base-3`, …). */
  private async uniqueSlug(tx: SQL, orgId: string, base: string): Promise<string> {
    const root = slugify(base)
    for (let i = 1; i < 10_000; i++) {
      const candidate = i === 1 ? root : `${root}-${i}`
      const hit = await tx<{ one: number }[]>`
        SELECT 1 AS one FROM workspaces WHERE org_id = ${orgId} AND slug = ${candidate} LIMIT 1`
      if (hit.length === 0) return candidate
    }
    return `${root}-${Bun.randomUUIDv7().slice(0, 8)}`
  }

  // -------------------------------------------------------------------------
  // Ingest — a RunSummaryRecord into invocations + task_runs + fingerprints
  // -------------------------------------------------------------------------

  /**
   * Persist one pushed run. Routes the workspace (§5.5), then writes the
   * invocation header + task rows + fingerprints and auto-provisions the
   * projects/tasks the run names — all in ONE transaction, idempotent on
   * (started_at, run_id). Returns whether the run was newly stored + the
   * resolved server workspace id.
   */
  async ingest(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    summary: RunSummaryRecord
    tokenId?: string | undefined
    now?: number
  }): Promise<{ stored: boolean; workspaceId: string }> {
    const now = args.now ?? Date.now()
    const r = args.summary.run
    const clientWorkspaceId =
      typeof r.workspaceId === 'string' && r.workspaceId !== '' ? r.workspaceId : 'default'
    const workspaceName =
      typeof r.workspaceName === 'string' && r.workspaceName !== ''
        ? r.workspaceName
        : clientWorkspaceId
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId,
      workspaceName,
      now,
    })

    const summary = args.summary
    const tokenId = args.tokenId ?? null
    const stored = await this.sql.begin(async (tx) => {
      const inserted = await tx<{ run_id: string }[]>`
        INSERT INTO invocations (
          run_id, org_id, workspace_id, command, requested_tasks, cache_policy, concurrency, flow,
          started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
          hit_local_count, hit_remote_count, exit_ok, commit_sha, branch, dirty, ci, ci_provider,
          host, os, arch, vx_version, tags, ingested_by_token)
        VALUES (
          ${r.runId}, ${args.orgId}, ${workspaceId}, ${r.command},
          ${JSON.stringify(r.requestedTasks)}::jsonb, ${r.cachePolicy}, ${r.concurrency}, ${r.flow},
          ${summary.startedAt}, ${summary.endedAt}, ${summary.totalDurationMs}, ${summary.taskCount},
          ${summary.failedCount}, ${summary.hitCount}, ${summary.hitLocalCount},
          ${summary.hitRemoteCount}, ${summary.exitOk}, ${r.commitSha}, ${r.branch}, ${r.dirty},
          ${r.ci}, ${r.ciProvider}, ${r.host}, ${r.os}, ${r.arch}, ${r.vxVersion},
          ${JSON.stringify(r.tags)}::jsonb, ${tokenId})
        ON CONFLICT (started_at, run_id) DO NOTHING
        RETURNING run_id`
      if (inserted.length === 0) return false

      const projectTasks = new Map<string, Set<string>>()
      for (const t of summary.tasks) {
        if (t.status === 'aborted') continue
        const startedAt =
          t.wallclockStartNs !== undefined
            ? summary.startedAt + Math.round(Number(t.wallclockStartNs) / 1e6)
            : summary.startedAt
        const endedAt =
          t.wallclockEndNs !== undefined
            ? summary.startedAt + Math.round(Number(t.wallclockEndNs) / 1e6)
            : summary.endedAt
        const cacheHit = t.cacheSource === 'local' || t.cacheSource === 'remote'
        await tx`INSERT INTO task_runs (
            org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms,
            started_at, ended_at, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
            cache_hit, attempts)
          VALUES (
            ${args.orgId}, ${workspaceId}, ${r.runId}, ${t.hash ?? ''}, ${t.project}, ${t.task},
            ${t.status}, ${t.exitCode}, ${t.durationMs}, ${startedAt}, ${endedAt},
            ${t.cpuMs ?? null}, ${t.peakRssBytes ?? null},
            ${t.wallclockStartNs !== undefined ? BigInt(t.wallclockStartNs) : null},
            ${t.wallclockEndNs !== undefined ? BigInt(t.wallclockEndNs) : null},
            ${cacheHit}, ${t.attempts ?? null})`
        let names = projectTasks.get(t.project)
        if (names === undefined) {
          names = new Set()
          projectTasks.set(t.project, names)
        }
        names.add(t.task)
      }

      // Auto-provision projects + task names (name-only; a catalog push
      // enriches them with config — DO NOTHING preserves that).
      for (const [project, taskNames] of projectTasks) {
        const projectId = await this.upsertProject(tx, args.orgId, workspaceId, project, now)
        for (const task of taskNames) {
          await tx`INSERT INTO project_tasks (project_id, task, updated_at)
                   VALUES (${projectId}, ${task}, ${now})
                   ON CONFLICT (project_id, task) DO NOTHING`
        }
      }

      // Output fingerprints (verify-cross-machine): idempotent per platform.
      for (const t of summary.tasks) {
        if (t.hash === undefined || !validFingerprint(t.outputFp)) continue
        const fp = t.outputFp
        const { files, truncated } = normalizeFpFiles(fp.files, fp.truncated)
        await tx`INSERT INTO output_fingerprints (
            org_id, workspace_id, hash, os, arch, tree, file_count, files, truncated,
            task_id, run_id, host, created_at)
          VALUES (
            ${args.orgId}, ${workspaceId}, ${t.hash}, ${r.os}, ${r.arch}, ${fp.tree},
            ${fp.fileCount}, ${files === null ? null : JSON.stringify(files)}::jsonb,
            ${truncated}, ${t.taskId}, ${r.runId}, ${r.host}, ${now})
          ON CONFLICT (workspace_id, hash, os, arch, tree) DO NOTHING`
      }
      return true
    })
    return { stored, workspaceId }
  }

  private async upsertProject(
    tx: SQL,
    orgId: string,
    workspaceId: string,
    name: string,
    now: number,
  ): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO projects (id, org_id, workspace_id, name, first_seen_at, last_seen_at)
      VALUES (${Bun.randomUUIDv7()}, ${orgId}, ${workspaceId}, ${name}, ${now}, ${now})
      ON CONFLICT (workspace_id, name) DO UPDATE SET last_seen_at = ${now}
      RETURNING id`
    return rows[0]!.id
  }

  // -------------------------------------------------------------------------
  // Log ingest — bounded per-task tails, idempotent, re-truncated server-side
  // -------------------------------------------------------------------------

  async ingestLogs(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    bundle: TaskLogBundle
    now?: number
  }): Promise<{ stored: number; workspaceId: string }> {
    const now = args.now ?? Date.now()
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId: args.bundle.workspaceId,
      workspaceName: args.bundle.workspaceId,
      now,
    })
    const bundle = args.bundle
    const stored = await this.sql.begin(async (tx) => {
      let runBudget = RUN_LOG_BUDGET_CHARS
      let count = 0
      // Failures already lead the bundle (drain order); process in order so a
      // hostile/huge body drops later successes, never the failures.
      for (const t of bundle.tasks) {
        if (runBudget <= 0) break
        const exists = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM task_logs
          WHERE workspace_id = ${workspaceId} AND run_id = ${bundle.runId} AND task_id = ${t.taskId}
          LIMIT 1`
        if (exists.length > 0) continue
        let content = t.content
        let extraTrunc = 0
        if (content.length > TASK_LOG_TAIL_CHARS) {
          const keep = content.slice(content.length - TASK_LOG_TAIL_CHARS)
          extraTrunc = content.length - keep.length
          content = keep
        }
        if (content.length > runBudget) {
          const keep = content.slice(content.length - runBudget)
          extraTrunc += content.length - keep.length
          content = keep
        }
        runBudget -= content.length
        const raw = Buffer.from(content, 'utf8')
        const useZstd = raw.length >= COMPRESS_THRESHOLD_BYTES
        const blob = useZstd ? Bun.zstdCompressSync(raw) : raw
        await tx`INSERT INTO task_logs (
            org_id, workspace_id, run_id, task_id, hash, status, codec, content,
            chars_full, truncated_head, created_at)
          VALUES (
            ${args.orgId}, ${workspaceId}, ${bundle.runId}, ${t.taskId}, ${t.hash ?? null},
            ${t.status}, ${useZstd ? 'zstd' : 'plain'}, ${blob}, ${t.charsFull},
            ${t.truncatedHeadChars + extraTrunc}, ${now})`
        count++
      }
      return count
    })
    return { stored, workspaceId }
  }

  // -------------------------------------------------------------------------
  // Catalog push (§5.6) — the lock-derived project + task index
  // -------------------------------------------------------------------------

  async ingestCatalog(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    push: CatalogPush
    now?: number
  }): Promise<{ workspaceId: string }> {
    const now = args.now ?? Date.now()
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId: args.push.workspaceId,
      workspaceName:
        args.push.workspaceName !== undefined && args.push.workspaceName !== ''
          ? args.push.workspaceName
          : args.push.workspaceId,
      now,
    })
    await this.sql.begin(async (tx) => {
      for (const p of args.push.projects) {
        const projectId = await this.upsertProject(tx, args.orgId, workspaceId, p.name, now)
        for (const t of p.tasks ?? []) {
          await tx`INSERT INTO project_tasks
              (project_id, task, config, cacheable, is_group, persistent, updated_at)
            VALUES (
              ${projectId}, ${t.task},
              ${t.config !== undefined ? JSON.stringify(t.config) : null}::jsonb,
              ${t.cacheable ?? null}, ${t.isGroup ?? null}, ${t.persistent ?? null}, ${now})
            ON CONFLICT (project_id, task) DO UPDATE SET
              config = EXCLUDED.config, cacheable = EXCLUDED.cacheable,
              is_group = EXCLUDED.is_group, persistent = EXCLUDED.persistent, updated_at = ${now}`
        }
      }
    })
    return { workspaceId }
  }

  // -------------------------------------------------------------------------
  // Workspace selection (the read-side org clamp)
  // -------------------------------------------------------------------------

  /**
   * Resolve which workspace a session read targets. `wsParam` (the `?ws=`
   * query) must belong to the org — a foreign/unknown/malformed id returns
   * null (→ 404). No param → the most-recently-active workspace, or null when
   * the org has none yet.
   */
  async resolveReadWorkspace(orgId: string, wsParam?: string | null): Promise<string | null> {
    if (wsParam !== null && wsParam !== undefined && wsParam !== '') {
      if (!UUID_RE.test(wsParam)) return null
      const rows = await this.sql<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${wsParam} AND org_id = ${orgId}`
      return rows.length > 0 ? wsParam : null
    }
    const rows = await this.sql<{ id: string }[]>`
      SELECT w.id AS id,
             COALESCE((SELECT MAX(last_seen_at) FROM repos WHERE workspace_id = w.id), w.created_at) AS seen
      FROM workspaces w WHERE w.org_id = ${orgId}
      ORDER BY seen DESC LIMIT 1`
    return rows[0]?.id ?? null
  }

  /** Every workspace in an org (id, name, slug, lastSeen, runCount) — the switcher. */
  async workspacesForOrg(orgId: string): Promise<WorkspaceEntry[]> {
    const rows = await this.sql<
      { id: string; name: string; slug: string; last_seen: string; run_count: number }[]
    >`
      SELECT w.id AS id, w.name AS name, w.slug AS slug,
             COALESCE((SELECT MAX(last_seen_at) FROM repos WHERE workspace_id = w.id), w.created_at) AS last_seen,
             (SELECT count(*)::int FROM invocations WHERE workspace_id = w.id) AS run_count
      FROM workspaces w WHERE w.org_id = ${orgId}
      ORDER BY last_seen DESC`
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      lastSeenAt: Number(r.last_seen),
      runCount: Number(r.run_count),
    }))
  }

  /** Workspace count for an org — the admin rollup / `/v1/meta` (org-scoped). */
  async workspaceCount(orgId: string): Promise<number> {
    const rows = await this.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM workspaces WHERE org_id = ${orgId}`
    return rows[0]!.c
  }
}
