// Core reads no `package.json`: a project is a directory with a vx.config,
// named by its config, a `discover` plugin or its path. A Turbo or Nx repo
// writes no vx.config, so its projects are the package manager's members,
// which `discover` names here (`memberProjects`). The mappers read scripts,
// names and dependencies, so each project's manifest is read here once
// per run: the members' as `discover` lists them, the rest once per
// projects array (core hands every `project` call of a run the same one).
import path from 'node:path'
import { type DiscoveredProject, type ProjectMeta } from '@vzn/vx'
import { listPackages, type PackageMeta } from './packages.js'

/** The manifests the last `discover` read, by directory. */
let listed = new Map<string, PackageMeta>()
const read = new WeakMap<readonly ProjectMeta[], Promise<PackageMeta[]>>()

/**
 * The package manager's members at `root` as `discover` entries, each
 * named by its `package.json`; none where the root holds no
 * `package.json` or `pnpm-workspace.yaml`.
 */
export async function memberProjects(root: string): Promise<DiscoveredProject[]> {
  const exists = await Promise.all(
    ['package.json', 'pnpm-workspace.yaml'].map((f) => Bun.file(path.join(root, f)).exists()),
  )
  const members = exists.some(Boolean) ? await listPackages(root) : []
  listed = new Map(members.map((m) => [path.resolve(m.dir), m]))
  return members.map((m) => ({ dir: m.dir, name: m.name }))
}

/** `metas` with each one's `package.json` (`{ name }` where it has none or it does not parse). */
export function withManifests(metas: readonly ProjectMeta[]): Promise<PackageMeta[]> {
  let out = read.get(metas)
  if (out === undefined) {
    out = Promise.all(metas.map(withManifest))
    read.set(metas, out)
  }
  return out
}

async function withManifest(meta: ProjectMeta): Promise<PackageMeta> {
  const known = listed.get(path.resolve(meta.dir))
  const pkg: unknown =
    known?.packageJson ??
    (await Bun.file(path.join(meta.dir, 'package.json'))
      .json()
      .catch(() => null))
  const packageJson =
    pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)
      ? (pkg as PackageMeta['packageJson'])
      : { name: meta.name }
  return { name: meta.name, dir: meta.dir, configPath: meta.configPath, packageJson }
}
