import path from 'node:path'
import type { WorkspaceConfig } from '../config.js'
import { UserError } from '../util/errors.js'

export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface Workspace {
  root: string
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

const CONFIG_FILENAMES = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']

export async function findWorkspaceRoot(start: string): Promise<string> {
  let dir = path.resolve(start)
  while (true) {
    if (await Bun.file(path.join(dir, 'pnpm-workspace.yaml')).exists()) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new UserError(`Could not find pnpm-workspace.yaml in any parent of ${start}`)
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

export async function loadWorkspace(root: string): Promise<Workspace> {
  const yamlPath = path.join(root, 'pnpm-workspace.yaml')
  const text = await Bun.file(yamlPath).text()
  const parsed = (Bun.YAML.parse(text) ?? {}) as { packages?: string[] }
  return { root, packageGlobs: parsed.packages ?? [] }
}

export async function listProjects(workspace: Workspace): Promise<ProjectMeta[]> {
  const matches = new Set<string>()
  for (const pattern of workspace.packageGlobs) {
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`)
    for await (const rel of glob.scan({
      cwd: workspace.root,
      onlyFiles: true,
      dot: false,
    })) {
      // Skip nested node_modules — workspace package globs shouldn't ever
      // reach into them, but a pathological pattern like `**` would.
      if (rel.split(path.sep).includes('node_modules')) continue
      matches.add(path.resolve(workspace.root, rel))
    }
  }

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
