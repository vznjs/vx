// The cloud-owned analytics store. A hosted vx-cloud does NOT read a
// developer's private cache.db; it ingests the canonical RunSummaryRecord
// (pushed by the cloud telemetry sink) into its OWN store and serves the
// dashboard from there.
//
// MULTI-WORKSPACE (dev-flows design §3.4): one store PER WORKSPACE —
// `<dir>/<workspaceId>/cache.db` — not workspace columns in one DB. Each
// store IS a core Cache at a cloud-owned path: core's Cache already builds
// the exact runs + invocations schema and `recordRunBundle` writes both
// atomically, so every analytics query in metrics.ts runs UNCHANGED against
// whichever workspace's store the serve resolves for a request. The
// artifact/entries tables exist but stay empty — cache-entry inventory is a
// local concern (the hosted dashboard shows run/task analytics only; see
// docs/design/observability-architecture-2026-06.md §6 option c).
//
// A `workspaces.json` manifest at the root carries display metadata
// (id → name, lastSeenAt), updated on every ingest. The per-workspace
// stores are the durable data; the manifest is rebuildable metadata.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { Cache, type InvocationRecord, type RunRecord, type RunSummaryRecord } from '@vzn/vx'
import { FpStore, type FpReport, type HermeticityResult } from './fp-store.js'
import { LogStore, type StoredTaskLog } from './log-store.js'
import type { TaskLogBundle } from './task-log-capture.js'

/** Where a v1 push (predating workspace identity) lands. */
export const DEFAULT_WORKSPACE_ID = 'default'

// Workspace ids become directory names under the ingest root. Core derives
// 16-hex ids, but a pushed body is a network boundary — accept only a safe
// path token so a hostile id can't traverse out of the root.
const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export interface WorkspaceEntry {
  id: string
  name: string
  lastSeenAt: number
  runCount?: number
}

interface ManifestEntry {
  name: string
  lastSeenAt: number
}

interface Manifest {
  version: 1
  workspaces: Record<string, ManifestEntry>
}

/**
 * Rows in `invocations` BEFORE core's Cache schema gate runs. Core drops
 * every table on a SCHEMA_VERSION mismatch — fine for a workspace cache,
 * but this store is the server's durable run HISTORY, so a wipe must at
 * least be loud. Read via a separate readonly handle so the count
 * predates the gate.
 */
function preGateInvocationCount(dir: string): number {
  const dbPath = path.join(dir, 'cache.db')
  if (!existsSync(dbPath)) return 0
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM invocations').get() as { n: number }
      return row.n
    } finally {
      db.close()
    }
  } catch {
    // No invocations table (pre-v22 file, or not a vx DB) — nothing to lose.
    return 0
  }
}

function readManifest(file: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    if (
      parsed.version === 1 &&
      typeof parsed.workspaces === 'object' &&
      parsed.workspaces !== null
    ) {
      return parsed
    }
  } catch {
    // absent / unreadable — start empty (display metadata only)
  }
  return { version: 1, workspaces: {} }
}

export class IngestStore {
  private readonly stores = new Map<string, Cache>()
  private readonly logStores = new Map<string, LogStore>()
  private readonly fpStores = new Map<string, FpStore>()
  private readonly manifest: Manifest
  private readonly manifestPath: string

  constructor(
    private readonly dir: string,
    private readonly warn?: (message: string) => void,
  ) {
    mkdirSync(dir, { recursive: true })
    this.manifestPath = path.join(dir, 'workspaces.json')
    this.manifest = readManifest(this.manifestPath)
    this.migrateLegacyStore()
  }

  /**
   * A pre-multi-workspace ingest dir holds `cache.db` directly at the root.
   * Move it (plus WAL sidecars) into `<dir>/default/` on boot — one rename,
   * loud log — so the layout stays uniform and v1 pushes keep appending to
   * the same history.
   */
  private migrateLegacyStore(): void {
    const legacy = path.join(this.dir, 'cache.db')
    if (!existsSync(legacy)) return
    const destDir = path.join(this.dir, DEFAULT_WORKSPACE_ID)
    mkdirSync(destDir, { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) {
      const from = legacy + suffix
      if (existsSync(from)) renameSync(from, path.join(destDir, `cache.db${suffix}`))
    }
    if (this.manifest.workspaces[DEFAULT_WORKSPACE_ID] === undefined) {
      this.manifest.workspaces[DEFAULT_WORKSPACE_ID] = {
        name: DEFAULT_WORKSPACE_ID,
        lastSeenAt: Date.now(),
      }
      this.writeManifest()
    }
    this.warn?.(
      `migrated legacy single-workspace ingest store to ${destDir} (workspace "${DEFAULT_WORKSPACE_ID}")`,
    )
  }

  private writeManifest(): void {
    const tmp = `${this.manifestPath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.manifest, null, 2)}\n`)
    renameSync(tmp, this.manifestPath)
  }

  private openStore(id: string): Cache {
    const existing = this.stores.get(id)
    if (existing !== undefined) return existing
    const storeDir = path.join(this.dir, id)
    // Core's Cache drops + recreates all tables when its SCHEMA_VERSION
    // moves (pre-alpha, no migrations). For this store that is DATA
    // LOSS, not cache invalidation — detect it and warn loudly so a
    // hosted operator learns why the dashboard is empty. Full schema
    // decoupling (an ingest-owned schema with additive migrations) is a
    // roadmap item; until then, snapshot the data volume before
    // upgrading vx-cloud.
    const before = this.warn !== undefined ? preGateInvocationCount(storeDir) : 0
    const cache = new Cache(storeDir)
    if (before > 0) {
      const after = cache.dbHandle().prepare('SELECT COUNT(*) AS n FROM invocations').get() as {
        n: number
      }
      if (after.n === 0) {
        this.warn!(
          `ingest store schema upgraded — run history for workspace "${id}" was reset (${before} invocation${before === 1 ? '' : 's'} dropped). ` +
            `Snapshot the ingest volume before upgrading vx-cloud to keep history across schema bumps.`,
        )
      }
    }
    this.stores.set(id, cache)
    return cache
  }

  /**
   * The DB handle the metrics queries read for one workspace, or undefined
   * for an id this store has never seen. `default` always resolves (lazily
   * created) so a fresh serve's reads work before the first push.
   */
  db(workspaceId: string): Database | undefined {
    if (!WORKSPACE_ID_RE.test(workspaceId)) return undefined
    const open = this.stores.get(workspaceId)
    if (open !== undefined) return open.dbHandle()
    const known =
      workspaceId === DEFAULT_WORKSPACE_ID ||
      this.manifest.workspaces[workspaceId] !== undefined ||
      existsSync(path.join(this.dir, workspaceId, 'cache.db'))
    if (!known) return undefined
    return this.openStore(workspaceId).dbHandle()
  }

  /**
   * The workspace an un-scoped request reads: the sole known workspace when
   * exactly one exists (a single-repo serve behaves exactly like the
   * pre-multi-workspace one); with several, `default` when it genuinely
   * exists (v1 pushes land there), else the most-recently-seen — a fresh
   * dashboard must never open onto an empty synthetic workspace when real
   * ones exist.
   */
  defaultWorkspaceId(): string {
    const entries = Object.entries(this.manifest.workspaces)
    if (entries.length === 1) return entries[0]![0]
    if (this.manifest.workspaces[DEFAULT_WORKSPACE_ID] !== undefined) return DEFAULT_WORKSPACE_ID
    let best = DEFAULT_WORKSPACE_ID
    let bestSeen = -1
    for (const [id, meta] of entries) {
      if (meta.lastSeenAt > bestSeen) {
        best = id
        bestSeen = meta.lastSeenAt
      }
    }
    return best
  }

  /** Manifest size — the pre-auth `/v1/meta` count (names never leak there). */
  workspaceCount(): number {
    return Object.keys(this.manifest.workspaces).length
  }

  /** Every known workspace: display metadata + its invocation count. */
  workspaces(): WorkspaceEntry[] {
    return Object.entries(this.manifest.workspaces)
      .map(([id, meta]): WorkspaceEntry => {
        const row = this.openStore(id)
          .dbHandle()
          .prepare('SELECT COUNT(*) AS n FROM invocations')
          .get() as { n: number }
        return { id, name: meta.name, lastSeenAt: meta.lastSeenAt, runCount: row.n }
      })
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /**
   * Persist one pushed run into its workspace's store, routed by the
   * summary's OWN identity — a v1 body (predates workspace identity)
   * synthesizes `default`. Idempotent: a re-delivered summary (same runId)
   * is ignored — returns false. The per-task `runs` rows have no unique key,
   * so we gate on the invocation header existing rather than relying on the
   * insert. Returns true when the run was newly stored.
   */
  ingest(summary: RunSummaryRecord): boolean {
    // Boundary: the body arrives off the network and the id becomes a
    // directory name — validate before touching the filesystem.
    const rawId = (summary.run as { workspaceId?: unknown }).workspaceId
    const wsId = typeof rawId === 'string' && rawId !== '' ? rawId : DEFAULT_WORKSPACE_ID
    if (!WORKSPACE_ID_RE.test(wsId)) throw new Error(`invalid workspace id: ${wsId}`)
    const rawName = (summary.run as { workspaceName?: unknown }).workspaceName
    const wsName = typeof rawName === 'string' && rawName !== '' ? rawName : wsId

    const cache = this.openStore(wsId)
    this.manifest.workspaces[wsId] = { name: wsName, lastSeenAt: Date.now() }
    this.writeManifest()

    const exists = cache
      .dbHandle()
      .prepare('SELECT 1 FROM invocations WHERE run_id = ?')
      .get(summary.run.runId)
    if (exists) return false

    const runs = summary.tasks
      .filter((t) => t.status !== 'aborted')
      .map((t): RunRecord => {
        const startedAt =
          t.wallclockStartNs !== undefined
            ? summary.startedAt + Math.round(Number(t.wallclockStartNs) / 1e6)
            : summary.startedAt
        const endedAt =
          t.wallclockEndNs !== undefined
            ? summary.startedAt + Math.round(Number(t.wallclockEndNs) / 1e6)
            : summary.endedAt
        return {
          hash: t.hash ?? '',
          project: t.project,
          task: t.task,
          status: t.status as RunRecord['status'],
          exitCode: t.exitCode,
          durationMs: t.durationMs,
          startedAt,
          endedAt,
          runId: summary.run.runId,
          ...(t.cpuMs !== undefined ? { cpuMs: t.cpuMs } : {}),
          ...(t.peakRssBytes !== undefined ? { peakRssBytes: t.peakRssBytes } : {}),
          ...(t.wallclockStartNs !== undefined
            ? { wallclockStartNs: BigInt(t.wallclockStartNs) }
            : {}),
          ...(t.wallclockEndNs !== undefined ? { wallclockEndNs: BigInt(t.wallclockEndNs) } : {}),
          cacheHit: t.cacheSource === 'local' || t.cacheSource === 'remote',
          ...(t.attempts !== undefined ? { attempts: t.attempts } : {}),
        }
      })

    const r = summary.run
    const invocation: InvocationRecord = {
      runId: r.runId,
      command: r.command,
      requestedTasks: JSON.stringify(r.requestedTasks),
      cachePolicy: r.cachePolicy,
      concurrency: r.concurrency,
      flow: r.flow,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      totalDurationMs: summary.totalDurationMs,
      taskCount: summary.taskCount,
      failedCount: summary.failedCount,
      hitCount: summary.hitCount,
      hitLocalCount: summary.hitLocalCount,
      hitRemoteCount: summary.hitRemoteCount,
      exitOk: summary.exitOk,
      commitSha: r.commitSha,
      branch: r.branch,
      dirty: r.dirty,
      ci: r.ci,
      ciProvider: r.ciProvider,
      host: r.host,
      os: r.os,
      arch: r.arch,
      vxVersion: r.vxVersion,
      tags: JSON.stringify(r.tags),
    }
    cache.recordRunBundle({ runs, invocation })

    // Output fingerprints (verify-cross-machine §3): a `--verify*` run's tasks
    // carry `outputFp`; persist them keyed by (cache key, platform) in the
    // per-workspace sidecar so `/v1/hermeticity` can diff across machines.
    // After the idempotency gate by construction — and the store's PK makes
    // even a bypassed gate harmless.
    const fpReports: FpReport[] = []
    for (const t of summary.tasks) {
      if (t.hash === undefined || t.outputFp === undefined) continue
      fpReports.push({
        hash: t.hash,
        os: r.os,
        arch: r.arch,
        host: r.host,
        taskId: t.taskId,
        runId: r.runId,
        fp: t.outputFp,
      })
    }
    if (fpReports.length > 0) this.openFpStore(wsId).ingest(fpReports)
    return true
  }

  /**
   * Persist a run's captured task-log tails into its workspace's `logs.db`
   * sidecar (routed by the bundle's OWN workspaceId — same network-boundary
   * validation as `ingest`). Returns the number of task rows newly stored.
   */
  ingestLogs(bundle: TaskLogBundle): number {
    if (!WORKSPACE_ID_RE.test(bundle.workspaceId)) {
      throw new Error(`invalid workspace id: ${bundle.workspaceId}`)
    }
    return this.openLogStore(bundle.workspaceId).ingestLogs(bundle)
  }

  /** The stored tail for one (run, task) in a workspace, or undefined. */
  logFor(workspaceId: string, runId: string, taskId: string): StoredTaskLog | undefined {
    if (!WORKSPACE_ID_RE.test(workspaceId)) return undefined
    return this.openLogStore(workspaceId).logFor(runId, taskId)
  }

  /** The most-recent stored log for a cache key — the hit→executed-run resolution. */
  logByHash(workspaceId: string, hash: string): StoredTaskLog | undefined {
    if (!WORKSPACE_ID_RE.test(workspaceId)) return undefined
    return this.openLogStore(workspaceId).latestByHash(hash)
  }

  /** The workspace's fingerprint divergence read (`GET /v1/hermeticity`). */
  hermeticity(workspaceId: string, limit: number): HermeticityResult | undefined {
    if (!WORKSPACE_ID_RE.test(workspaceId)) return undefined
    return this.openFpStore(workspaceId).hermeticity(limit)
  }

  private openLogStore(id: string): LogStore {
    const existing = this.logStores.get(id)
    if (existing !== undefined) return existing
    const storeDir = path.join(this.dir, id)
    mkdirSync(storeDir, { recursive: true })
    const store = new LogStore(storeDir, undefined, this.warn)
    this.logStores.set(id, store)
    return store
  }

  private openFpStore(id: string): FpStore {
    const existing = this.fpStores.get(id)
    if (existing !== undefined) return existing
    const storeDir = path.join(this.dir, id)
    mkdirSync(storeDir, { recursive: true })
    const store = new FpStore(storeDir, undefined, this.warn)
    this.fpStores.set(id, store)
    return store
  }

  close(): void {
    for (const cache of this.stores.values()) cache.close()
    this.stores.clear()
    for (const logs of this.logStores.values()) logs.close()
    this.logStores.clear()
    for (const fps of this.fpStores.values()) fps.close()
    this.fpStores.clear()
  }
}
