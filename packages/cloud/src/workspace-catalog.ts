// The workspace catalog — "access the LOCK" (cloud-data-model-2026-07 §6).
// A colocated-workspace live feature, exactly like the serve's /v1/graph:
// it reads the workspace's COMMITTED config surface (vx-lock.json and
// vx.config.* files) — never core's cache.db, never the .vx/ state dir —
// so the serve stays independently deployable; a remote ingest-only serve
// simply has no workspace and 404s the catalog routes.
//
// Resolution ladder (§6.2):
//   1. lock-first (instant, zero eval): readLockfile — the frozen resolved
//      configs, exactly what a --frozen run would see;
//   2. live fallback (no lock): loadWorkspace → listProjectMetas →
//      loadProjectConfig per project — the same loader chain `vx show` uses;
//   3. no workspace at all → null (the routes answer 404).
//
// Memoization: per (configPath, mtimeMs, size) for both the live-eval
// result and the lock-staleness hash, so warm catalog requests are
// stat-only. No TTL — a touched config file invalidates its own entry.

import path from 'node:path'
import { stat } from 'node:fs/promises'
import {
  captureWorkspaceIdentity,
  listProjectMetas,
  loadProjectConfig,
  loadWorkspace,
  LOCKFILE_NAME,
  readLockfile,
  type Lockfile,
  type ProjectConfig,
  type TaskConfig,
} from '@vzn/vx'

/** The digest `vx lock` writes: xxh3 of the config file bytes, fixed 16-hex. */
function xxh3hex(bytes: Uint8Array): string {
  return Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')
}

function toPosix(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/')
}

export interface CatalogProjectSummary {
  name: string
  /** Workspace-root-relative POSIX dir; `.` for the root project. */
  dir: string
  /** Workspace-root-relative POSIX path to the vx config file. */
  configPath: string
  taskCount: number
  tasks: string[]
}

export interface CatalogProjectsResponse {
  source: 'lock' | 'live'
  root: string
  workspaceId: string
  /** Lock file mtime (lock mode only). */
  lockedAt?: number
  /** Lock mode: projects whose config bytes drifted since `vx lock`. */
  staleProjects?: string[]
  projects: CatalogProjectSummary[]
}

export interface CatalogProjectDetail {
  source: 'lock' | 'live'
  name: string
  dir: string
  configPath: string
  /** Lock mode: this project's config bytes drifted since `vx lock`. */
  stale?: boolean
  /** Resolved, JSON-normalized config — the `vx show` payload. */
  config: ProjectConfig
}

export interface CatalogTaskRow {
  id: string
  project: string
  task: string
  description?: string
  group: boolean
  cacheable: boolean
  persistent: boolean
  dependsOn: readonly string[]
}

export interface CatalogTasksResponse {
  source: 'lock' | 'live'
  tasks: CatalogTaskRow[]
}

/** The internal resolved form the response builders read from. */
export interface ResolvedCatalog {
  source: 'lock' | 'live'
  lockedAt?: number
  /** Lock mode: names with configHash drift (empty in live mode). */
  stale: ReadonlySet<string>
  projects: readonly {
    name: string
    dir: string
    configPath: string
    config: ProjectConfig
  }[]
}

interface MemoEntry {
  mtimeMs: number
  size: number
  /** xxh3hex of the file bytes — the lock-staleness comparison side. */
  hash?: string
  /** The live-eval result. */
  config?: ProjectConfig
}

export class WorkspaceCatalog {
  private readonly root: string
  private readonly evalConfig: (configPath: string) => Promise<ProjectConfig>
  /** Keyed by absolute configPath; invalidated by (mtimeMs, size) drift. */
  private readonly memo = new Map<string, MemoEntry>()
  private workspaceId: string | undefined

  constructor(
    root: string,
    opts?: {
      /** Injectable eval dependency so tests can count evaluations. */
      evalConfig?: (configPath: string) => Promise<ProjectConfig>
    },
  ) {
    this.root = root
    this.evalConfig = opts?.evalConfig ?? ((p) => loadProjectConfig(p))
  }

  /**
   * Cheap availability probe for the /v1/meta capability advertisement:
   * a readable lock, or a discoverable workspace — no config eval.
   */
  async available(): Promise<boolean> {
    try {
      if ((await readLockfile(this.root)) !== null) return true
    } catch {
      // malformed lock — the resolve ladder falls back to live below
    }
    try {
      await loadWorkspace(this.root)
      return true
    } catch {
      return false
    }
  }

  /** Run the resolution ladder. `null` = no colocated workspace (→ 404). */
  async resolve(): Promise<ResolvedCatalog | null> {
    let lock: Lockfile | null = null
    try {
      lock = await readLockfile(this.root)
    } catch {
      // A malformed lock must not 500 a read-only introspection surface;
      // `vx lock --check` is the audit path. Fall back to live eval.
    }
    if (lock !== null) return await this.fromLock(lock)
    return await this.fromLive()
  }

  private async fromLock(lock: Lockfile): Promise<ResolvedCatalog> {
    const names = Object.keys(lock.projects).sort((a, b) => a.localeCompare(b))
    const stale = new Set<string>()
    const projects = await Promise.all(
      names.map(async (name) => {
        const entry = lock.projects[name]!
        const abs = path.join(this.root, entry.configPath)
        const hash = await this.hashFor(abs)
        // A vanished config file counts as drift too — the lock no longer
        // describes what a live evaluation would see.
        if (hash !== entry.configHash) stale.add(name)
        const dir = path.posix.dirname(entry.configPath)
        return { name, dir, configPath: entry.configPath, config: entry.config }
      }),
    )
    let lockedAt: number | undefined
    try {
      lockedAt = (await stat(path.join(this.root, LOCKFILE_NAME))).mtimeMs
    } catch {
      // lock deleted between read and stat — omit the timestamp
    }
    return {
      source: 'lock',
      ...(lockedAt !== undefined ? { lockedAt } : {}),
      stale,
      projects,
    }
  }

  private async fromLive(): Promise<ResolvedCatalog | null> {
    let metas
    try {
      const workspace = await loadWorkspace(this.root)
      metas = await listProjectMetas(workspace)
    } catch {
      // Not a workspace root (an ingest-only / remote serve).
      return null
    }
    const configured = metas.filter(
      (m): m is typeof m & { configPath: string } => m.configPath !== null,
    )
    const loaded = await Promise.all(
      configured.map(async (m) => {
        const config = await this.configFor(m.configPath)
        if (config === null) return null // config vanished mid-listing
        const rel = toPosix(path.relative(this.root, m.configPath))
        const dir = path.posix.dirname(rel)
        return { name: m.name, dir, configPath: rel, config }
      }),
    )
    return {
      source: 'live',
      stale: new Set<string>(),
      projects: loaded.filter((p) => p !== null),
    }
  }

  /** Stat-gated memo slot for one config file; null when the file is gone. */
  private async slotFor(absPath: string): Promise<MemoEntry | null> {
    let st
    try {
      st = await stat(absPath)
    } catch {
      this.memo.delete(absPath)
      return null
    }
    let entry = this.memo.get(absPath)
    if (entry === undefined || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = { mtimeMs: st.mtimeMs, size: st.size }
      this.memo.set(absPath, entry)
    }
    return entry
  }

  private async hashFor(absPath: string): Promise<string | null> {
    const entry = await this.slotFor(absPath)
    if (entry === null) return null
    entry.hash ??= xxh3hex(await Bun.file(absPath).bytes())
    return entry.hash
  }

  private async configFor(absPath: string): Promise<ProjectConfig | null> {
    const entry = await this.slotFor(absPath)
    if (entry === null) return null
    entry.config ??= await this.evalConfig(absPath)
    return entry.config
  }

  // -------------------------------------------------------------------
  // Response builders (§6.3 shapes).
  // -------------------------------------------------------------------

  projectsResponse(resolved: ResolvedCatalog): CatalogProjectsResponse {
    // The workspace identity is stable for a serve's lifetime (git remote /
    // persisted salt), so one capture (a single git spawn) is enough.
    this.workspaceId ??= captureWorkspaceIdentity(this.root).id
    return {
      source: resolved.source,
      root: this.root,
      workspaceId: this.workspaceId,
      ...(resolved.lockedAt !== undefined ? { lockedAt: resolved.lockedAt } : {}),
      ...(resolved.source === 'lock' ? { staleProjects: [...resolved.stale].sort() } : {}),
      projects: resolved.projects.map((p) => {
        const tasks = Object.keys(p.config.tasks ?? {})
        return {
          name: p.name,
          dir: p.dir,
          configPath: p.configPath,
          taskCount: tasks.length,
          tasks,
        }
      }),
    }
  }

  projectResponse(resolved: ResolvedCatalog, name: string): CatalogProjectDetail | null {
    const p = resolved.projects.find((x) => x.name === name)
    if (p === undefined) return null
    return {
      source: resolved.source,
      name: p.name,
      dir: p.dir,
      configPath: p.configPath,
      ...(resolved.stale.has(p.name) ? { stale: true } : {}),
      config: p.config,
    }
  }

  tasksResponse(resolved: ResolvedCatalog): CatalogTasksResponse {
    const tasks: CatalogTaskRow[] = []
    for (const p of resolved.projects) {
      for (const [taskName, cfg] of Object.entries(p.config.tasks ?? {})) {
        const t = cfg as TaskConfig
        tasks.push({
          id: `${p.name}#${taskName}`,
          project: p.name,
          task: taskName,
          ...(t.description !== undefined ? { description: t.description } : {}),
          // Derived serve-side so views never re-derive schema semantics.
          group: t.exec === undefined,
          cacheable: t.cache !== undefined,
          persistent: t.exec?.persistent !== undefined,
          dependsOn: t.dependsOn ?? [],
        })
      }
    }
    return { source: resolved.source, tasks }
  }
}
