import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { glob } from 'tinyglobby'
import { parse as parseYaml } from 'yaml'

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
  /** Absolute path to nxt.config.{ts,js,mjs,cjs} or null. */
  configPath: string | null
}

const CONFIG_FILENAMES = ['nxt.config.ts', 'nxt.config.mts', 'nxt.config.js', 'nxt.config.mjs']

export function findWorkspaceRoot(start: string): string {
  let dir = path.resolve(start)
  while (true) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not find pnpm-workspace.yaml in any parent of ${start}`)
    }
    dir = parent
  }
}

export async function loadWorkspace(root: string): Promise<Workspace> {
  const yamlPath = path.join(root, 'pnpm-workspace.yaml')
  const text = await readFile(yamlPath, 'utf8')
  const parsed = (parseYaml(text) ?? {}) as { packages?: string[] }
  return { root, packageGlobs: parsed.packages ?? [] }
}

export async function listProjects(workspace: Workspace): Promise<ProjectMeta[]> {
  const patterns = workspace.packageGlobs.map((g) => `${g.replace(/\/$/, '')}/package.json`)
  const matches = await glob(patterns, {
    cwd: workspace.root,
    absolute: true,
    dot: false,
    ignore: ['**/node_modules/**'],
  })

  const projects: ProjectMeta[] = []
  for (const pkgJsonPath of matches) {
    const dir = path.dirname(pkgJsonPath)
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as PackageJson
    if (!pkg.name) continue
    const configPath =
      CONFIG_FILENAMES.map((f) => path.join(dir, f)).find((f) => existsSync(f)) ?? null
    projects.push({ name: pkg.name, dir, packageJson: pkg, configPath })
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}
