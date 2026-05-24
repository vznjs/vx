import { isAbsolute, join, resolve } from 'node:path'
import type { Discover, Project } from './types.ts'

interface PnpmWorkspaceYaml {
  packages?: readonly string[]
}

interface RootPackageJson {
  name?: string
  workspaces?: readonly string[] | { packages?: readonly string[] }
}

interface ProjectPackageJson {
  name?: string
}

export const discover: Discover = async ({ root }) => {
  const absRoot = isAbsolute(root) ? root : resolve(root)

  const [rootPkg, pnpmRaw] = await Promise.all([
    readJsonOrNull<RootPackageJson>(join(absRoot, 'package.json')),
    readTextOrNull(join(absRoot, 'pnpm-workspace.yaml')),
  ])

  const globs = resolveGlobs(pnpmRaw, rootPkg)

  if (globs.length === 0) {
    const projects: Project[] = rootPkg?.name ? [{ name: rootPkg.name, dir: absRoot }] : []
    return { root: absRoot, projects }
  }

  const seen = new Set<string>()
  const projects: Project[] = []

  for (const pattern of globs) {
    const fromPattern = await projectsForPattern(absRoot, pattern, rootPkg)
    for (const project of fromPattern) {
      if (seen.has(project.dir)) continue
      seen.add(project.dir)
      projects.push(project)
    }
  }

  projects.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  return { root: absRoot, projects }
}

function resolveGlobs(pnpmRaw: string | null, rootPkg: RootPackageJson | null): readonly string[] {
  if (pnpmRaw !== null) {
    const pnpm = Bun.YAML.parse(pnpmRaw) as PnpmWorkspaceYaml | null
    return pnpm?.packages ?? []
  }
  const ws = rootPkg?.workspaces
  if (Array.isArray(ws)) return ws
  if (ws && typeof ws === 'object' && 'packages' in ws && Array.isArray(ws.packages)) {
    return ws.packages
  }
  return []
}

async function projectsForPattern(
  absRoot: string,
  pattern: string,
  rootPkg: RootPackageJson | null,
): Promise<readonly Project[]> {
  if (pattern === '.' || pattern === './') {
    return rootPkg?.name ? [{ name: rootPkg.name, dir: absRoot }] : []
  }

  const glob = new Bun.Glob(pattern)
  const matches: string[] = []
  for await (const rel of glob.scan({ cwd: absRoot, onlyFiles: false })) {
    matches.push(rel)
  }

  const candidates = await Promise.all(
    matches.map(async (rel) => {
      const dir = join(absRoot, rel)
      const pkg = await readJsonOrNull<ProjectPackageJson>(join(dir, 'package.json'))
      return { dir, name: pkg?.name }
    }),
  )

  const projects: Project[] = []
  for (const c of candidates) {
    if (!c.name) continue
    projects.push({ name: c.name, dir: c.dir })
  }
  return projects
}

async function readTextOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path)
  if (!(await f.exists())) return null
  try {
    return await f.text()
  } catch {
    return null
  }
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  const f = Bun.file(path)
  if (!(await f.exists())) return null
  try {
    return (await f.json()) as T
  } catch {
    return null
  }
}
