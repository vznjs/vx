import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { UserError } from '../util/index.js'

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
 * Walk up from `start` to find the workspace root. A directory is a
 * workspace root if it contains either:
 *   - `pnpm-workspace.yaml`, OR
 *   - a `package.json` (with or without a `workspaces` field).
 *
 * The first match wins. A bare `package.json` without `workspaces`
 * means a single-project workspace (the root itself IS the project).
 * Throws a `UserError` if neither signal is found before `/`.
 */
export async function findWorkspaceRoot(start: string): Promise<string> {
  let dir = path.resolve(start)
  while (true) {
    if (await Bun.file(path.join(dir, 'pnpm-workspace.yaml')).exists()) return dir
    if (await Bun.file(path.join(dir, 'package.json')).exists()) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new UserError(
        `Could not find a workspace root in any parent of ${start} ` +
          `(looked for pnpm-workspace.yaml or package.json)`,
      )
    }
    dir = parent
  }
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
  const yamlPath = path.join(root, 'pnpm-workspace.yaml')
  if (await Bun.file(yamlPath).exists()) {
    const parsed = (Bun.YAML.parse(await Bun.file(yamlPath).text()) ?? {}) as {
      packages?: string[]
    }
    return { root, packageGlobs: parsed.packages ?? [] }
  }

  const pkgPath = path.join(root, 'package.json')
  if (await Bun.file(pkgPath).exists()) {
    const pkg = (await Bun.file(pkgPath).json()) as PackageJson
    const ws = pkg.workspaces
    if (Array.isArray(ws)) return { root, packageGlobs: ws }
    if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
      return { root, packageGlobs: ws.packages }
    }
    // Bare package.json with no `workspaces` — single-project mode.
    // Treat the root itself as the only project.
    return { root, packageGlobs: ['.'] }
  }

  // Should be unreachable: findWorkspaceRoot only returns dirs that
  // pass at least one of the two existence checks.
  throw new UserError(`workspace root ${root} has neither pnpm-workspace.yaml nor package.json`)
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

  const projects: ProjectMeta[] = []
  const seenName = new Map<string, string>()
  for (const pkgJsonPath of matches) {
    const dir = path.dirname(pkgJsonPath)
    const pkg = (await Bun.file(pkgJsonPath).json()) as PackageJson
    if (!pkg.name) continue
    const previous = seenName.get(pkg.name)
    if (previous) {
      throw new UserError(
        `Duplicate package name "${pkg.name}" in workspace: ${previous} and ${dir}`,
      )
    }
    seenName.set(pkg.name, dir)
    const configPath = await firstExisting(CONFIG_FILENAMES.map((f) => path.join(dir, f)))
    projects.push({ name: pkg.name, dir, packageJson: pkg, configPath })
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (await Bun.file(p).exists()) return p
  }
  return null
}
