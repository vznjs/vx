import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { relPosix, UserError } from '../util/index.js'

export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** npm / yarn / bun workspaces. May be a glob array or { packages: [...] }. */
  workspaces?: string[] | { packages?: string[] }
}

export interface Workspace {
  root: string
  /** Glob patterns relative to root that match project directories. */
  packageGlobs: string[]
}

export interface ProjectMeta {
  /** Canonical name from package.json. */
  name: string
  /** Absolute path to the project directory. */
  dir: string
  packageJson: PackageJson
  /** Absolute path to vx.config.{ts,mts,js,mjs} or null. */
  configPath: string | null
}

/** A discovered project joined with its loaded vx config. */
export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}

const CONFIG_FILENAMES = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']

/**
 * Walk up from `start` to find the workspace root. A directory is a root
 * CANDIDATE when it contains `pnpm-workspace.yaml` or a `package.json`.
 *
 * The nearest candidate that CLAIMS `start` wins — one of the directories
 * between it and `start` matches one of its package globs. Every workspace
 * member has its own `package.json`, so stopping at the first candidate would
 * make a run from inside a package treat that package as the whole workspace:
 * `^task` edges vanish, upstream hashes drop out of the cache key (stale
 * hits), and a second cache dir appears under the member. Claiming is decided
 * with the same globs `loadWorkspace` applies, so "the root that claims me"
 * and "the root that lists me as a project" cannot diverge.
 *
 * When no candidate claims `start` — a standalone package, or a subdirectory
 * of a single-project repo — the nearest candidate wins (the root itself IS
 * the project). Throws a `UserError` when there is no candidate before `/`.
 */
export async function findWorkspaceRoot(start: string): Promise<string> {
  let dir = path.resolve(start)
  const below: string[] = []
  let nearest: string | null = null
  while (true) {
    let globs: string[] | null
    try {
      globs = await readPackageGlobs(dir)
    } catch {
      // An unparseable manifest is still a root SIGNAL (the pre-existing
      // behaviour probed only for existence); it just can't claim members.
      // `loadWorkspace` surfaces the parse error if this dir is chosen.
      globs = []
    }
    if (globs !== null) {
      nearest ??= dir
      if (claimsMember(dir, below, globs)) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    below.push(dir)
    dir = parent
  }
  if (nearest !== null) return nearest
  throw new UserError(
    `Could not find a workspace root in any parent of ${start} ` +
      `(looked for pnpm-workspace.yaml or package.json)`,
  )
}

/** True when one of `below` (dirs under `root`, toward `start`) is a member. */
function claimsMember(root: string, below: readonly string[], globs: readonly string[]): boolean {
  if (below.length === 0 || globs.length === 0) return false
  const rels = below.map((d) => relPosix(root, d))
  for (const pattern of globs) {
    const normalized = pattern.replace(/\/+$/, '')
    // `.` means the root itself is the project — never a directory below it.
    if (normalized === '' || normalized === '.') continue
    const glob = new Bun.Glob(normalized)
    if (rels.some((rel) => glob.match(rel))) return true
  }
  return false
}

/**
 * Package globs declared by `dir`, or `null` when `dir` is not a root
 * candidate. A bare `package.json` (no `workspaces`) is single-project mode:
 * the root itself is the only project, hence `['.']`.
 */
async function readPackageGlobs(dir: string): Promise<string[] | null> {
  const yamlPath = path.join(dir, 'pnpm-workspace.yaml')
  if (await Bun.file(yamlPath).exists()) {
    const parsed = (Bun.YAML.parse(await Bun.file(yamlPath).text()) ?? {}) as {
      packages?: string[]
    }
    return parsed.packages ?? []
  }
  const pkgPath = path.join(dir, 'package.json')
  if (!(await Bun.file(pkgPath).exists())) return null
  const pkg = (await Bun.file(pkgPath).json()) as PackageJson
  const ws = pkg.workspaces
  if (Array.isArray(ws)) return ws
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) return ws.packages
  return ['.']
}

/**
 * Resolve the cache directory for a workspace. Respects the user's
 * `defineWorkspace({ cacheDir })` override (relative to the workspace
 * root) and falls back to `.vx/cache` when no config is set.
 */
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string {
  const rel = config?.cacheDir ?? path.join('.vx', 'cache')
  return path.resolve(root, rel)
}

/**
 * Read the workspace's package-glob list, supporting all common
 * package managers:
 *   - `pnpm-workspace.yaml` (pnpm)
 *   - `package.json` `workspaces` array (npm / yarn / bun)
 *   - `package.json` `workspaces.packages` array (yarn legacy)
 *
 * If a `package.json` exists with no `workspaces` field, the root
 * itself is treated as a single-project workspace.
 */
export async function loadWorkspace(root: string): Promise<Workspace> {
  const packageGlobs = await readPackageGlobs(root)
  if (packageGlobs === null) {
    // Should be unreachable: findWorkspaceRoot only returns dirs that
    // pass at least one of the two existence checks.
    throw new UserError(`workspace root ${root} has neither pnpm-workspace.yaml nor package.json`)
  }
  return { root, packageGlobs }
}

export async function listProjects(workspace: Workspace): Promise<ProjectMeta[]> {
  // Run all package globs concurrently. Disk-bound walks parallelize
  // well; serializing them just stretches the discovery phase by N×.
  const perPattern = await Promise.all(
    workspace.packageGlobs.map(async (pattern) => {
      // Normalize: `"."` -> the root itself; `"foo/"` -> `"foo"`.
      const normalized = pattern === '.' ? '' : pattern.replace(/\/$/, '')
      const globPattern = normalized === '' ? 'package.json' : `${normalized}/package.json`
      const glob = new Bun.Glob(globPattern)
      const hits: string[] = []
      for await (const rel of glob.scan({
        cwd: workspace.root,
        onlyFiles: true,
        dot: false,
      })) {
        // Skip nested node_modules — workspace package globs shouldn't
        // ever reach into them, but a pathological pattern like `**`
        // would. Avoid splitting the path on the hot loop.
        if (rel.includes(`${path.sep}node_modules${path.sep}`)) continue
        if (rel.startsWith(`node_modules${path.sep}`)) continue
        hits.push(path.resolve(workspace.root, rel))
      }
      return hits
    }),
  )
  const matches = new Set<string>()
  for (const arr of perPattern) for (const m of arr) matches.add(m)

  // Per-project I/O (manifest read + config discovery) is independent
  // — run it all concurrently, then a deterministic sequential pass
  // for the duplicate-name check. One readdir per project replaces
  // up to four exists() probes (CONFIG_FILENAMES has 4 candidates):
  // ~5440 awaited syscalls → ~2180 concurrent ones at 1090 projects.
  const loaded = await Promise.all(
    [...matches].map(async (pkgJsonPath) => {
      const dir = path.dirname(pkgJsonPath)
      const [pkg, entries] = await Promise.all([
        Bun.file(pkgJsonPath).json() as Promise<PackageJson>,
        readdir(dir).catch(() => [] as string[]),
      ])
      const names = new Set(entries)
      const configName = CONFIG_FILENAMES.find((f) => names.has(f))
      const configPath = configName !== undefined ? path.join(dir, configName) : null
      return { dir, pkg, configPath }
    }),
  )

  const projects: ProjectMeta[] = []
  const seenName = new Map<string, string>()
  for (const { dir, pkg, configPath } of loaded) {
    if (!pkg.name) {
      // A nameless manifest can't be addressed, filtered, or made affected —
      // and vx identifies projects by name, so it simply vanishes. Silent is
      // fine for a dir that declares no tasks; a dir with a vx config was
      // meant to run.
      if (configPath !== null) {
        process.stderr.write(
          `vx: ${relPosix(workspace.root, dir)} has a vx config but its package.json has no "name" — skipped\n`,
        )
      }
      continue
    }
    const previous = seenName.get(pkg.name)
    if (previous) {
      throw new UserError(
        `Duplicate package name "${pkg.name}" in workspace: ${previous} and ${dir}`,
      )
    }
    seenName.set(pkg.name, dir)
    projects.push({ name: pkg.name, dir, packageJson: pkg, configPath })
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}
