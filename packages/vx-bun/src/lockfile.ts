// bun.lock → one digest per workspace package over the packages it can
// reach. The text lockfile is JSONC: `workspaces` (root-relative dir →
// manifest: name + dependency maps) and `packages` (a node_modules path →
// `[id, registry, { dependencies, optionalDependencies, peerDependencies }, integrity]`;
// a workspace package is `[name@workspace:dir]`, a git or tarball
// package a shorter tuple). Bun hoists: a dependency `d` of the package
// at path `p` resolves to `p/d` when that key exists, else to the nearest
// ancestor's `…/d`, else to `d` at the root — the same walk Node's
// resolver makes through nested node_modules.
//
// Bun.JSONC is the parser: no dependency, and the file is Bun's own.

import { reachDigests } from '@vzn/vx'

export interface Lockfile {
  readonly version: string
  /** root-relative dir (`.` for the root) → dependency name → specifier */
  readonly workspaces: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** workspace package name → its dir */
  readonly workspaceDirs: ReadonlyMap<string, string>
  /** node_modules path → the package there */
  readonly packages: ReadonlyMap<string, Entry>
  /** Material every workspace folds: the lockfile version and install-wide knobs. */
  readonly global: string
}

export interface Entry {
  /** `name@version`, `name@workspace:dir`, `name@github:…` */
  readonly id: string
  readonly deps: ReadonlyMap<string, string>
  /** integrity / commit — whatever pins the bytes */
  readonly resolution: string
}

type Json = Record<string, unknown>
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

export function parseLockfile(text: string): Lockfile {
  let doc: unknown
  try {
    doc = Bun.JSONC.parse(text)
  } catch (err) {
    throw new Error(`bun.lock: ${err instanceof Error ? err.message : String(err)}`)
  }
  const d = record(doc)
  if (d === undefined || typeof d['lockfileVersion'] !== 'number') {
    throw new Error('bun.lock: not a Bun text lockfile (no lockfileVersion)')
  }
  const workspaces = new Map<string, ReadonlyMap<string, string>>()
  const workspaceDirs = new Map<string, string>()
  for (const [dir, manifest] of Object.entries(record(d['workspaces']) ?? {})) {
    const m = record(manifest) ?? {}
    const key = dir === '' ? '.' : dir
    workspaces.set(key, depsOf(m))
    if (typeof m['name'] === 'string') workspaceDirs.set(m['name'], key)
  }
  const packages = new Map<string, Entry>()
  for (const [p, tuple] of Object.entries(record(d['packages']) ?? {})) {
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string') continue
    const meta = tuple.find((v) => record(v) !== undefined)
    const resolution = tuple.slice(1).findLast((v) => typeof v === 'string' && v.length > 0)
    packages.set(p, {
      id: tuple[0],
      deps: depsOf(record(meta) ?? {}),
      resolution: typeof resolution === 'string' ? resolution : '',
    })
  }
  const global = JSON.stringify({
    lockfileVersion: d['lockfileVersion'],
    configVersion: d['configVersion'],
    overrides: d['overrides'],
    patchedDependencies: d['patchedDependencies'],
    catalog: d['catalog'],
    catalogs: d['catalogs'],
  })
  return { version: String(d['lockfileVersion']), workspaces, workspaceDirs, packages, global }
}

function depsOf(m: Json): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const field of DEP_FIELDS) {
    const deps = record(m[field])
    if (deps === undefined) continue
    for (const [name, spec] of Object.entries(deps)) out.set(name, String(spec))
  }
  return out
}

function record(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/**
 * Where dependency `name` of the package at node_modules path `from`
 * lives: the deepest `…/name` key up the path, then the root. A workspace
 * package sits at its own name (`@vzn/vx`) and resolves from there.
 */
function resolve(lock: Lockfile, from: string, name: string): string | undefined {
  let base = from
  for (;;) {
    const key = base === '' ? name : `${base}/${name}`
    if (lock.packages.has(key)) return key
    if (base === '') return undefined
    const slash = base.lastIndexOf('/')
    // A scoped segment (`@s/x`) is one level; `@s/x/y/z` → `@s/x/y` → `@s/x` → ''.
    base = slash === -1 ? '' : base.slice(0, slash)
    if (base.startsWith('@') && !base.includes('/')) base = ''
  }
}

/**
 * Every workspace package's digest (by dir): the lockfile as one graph —
 * a node per node_modules path, its material the id + resolution, an edge
 * per resolved dependency — folded by core's `reachDigests`. A workspace
 * dependency (`workspace:` id) is a node like any other, so what project
 * A can import through workspace package B is B's whole reach.
 */
export function importerDigests(lock: Lockfile): ReadonlyMap<string, string> {
  const index = new Map<string, number>()
  const material: string[] = []
  const edges: number[][] = []
  const node = (id: string, own: string): number => {
    let i = index.get(id)
    if (i === undefined) {
      i = material.length
      index.set(id, i)
      material.push(own)
      edges.push([])
    }
    return i
  }
  for (const [p, e] of lock.packages) node(p, `${p}\0${e.id}\0${e.resolution}`)
  for (const [p, e] of lock.packages) {
    const from = index.get(p)!
    for (const [name, spec] of e.deps) {
      const target = resolve(lock, p, name)
      if (target !== undefined) edges[from]!.push(index.get(target)!)
      else material[from] += `\nunresolved\0${name}\0${spec}`
    }
  }
  // A workspace importer resolves like the package at its own name; the
  // root importer ('') resolves from the root.
  const importers = new Map<string, number>()
  for (const [dir, deps] of lock.workspaces) {
    const own = node(`workspace\0${dir}`, 'workspace')
    importers.set(dir, own)
    let from = ''
    for (const [name, wsDir] of lock.workspaceDirs) if (wsDir === dir && dir !== '.') from = name
    for (const [name, spec] of deps) {
      const target = resolve(lock, from, name)
      if (target !== undefined) edges[own]!.push(index.get(target)!)
      else material[own] += `\nunresolved\0${name}\0${spec}`
    }
  }
  // A workspace package's node carries no dependencies of its own — they
  // live on its importer — so the node points at the importer: what a
  // project can import through workspace package B is B's whole reach.
  for (const [p, e] of lock.packages) {
    const at = e.id.indexOf('@workspace:')
    if (at === -1) continue
    const target = importers.get(e.id.slice(at + '@workspace:'.length) || '.')
    if (target !== undefined) edges[index.get(p)!]!.push(target)
  }
  const digests = reachDigests({ material, edges })
  const out = new Map<string, string>()
  const seed = Bun.hash.xxHash3(lock.global)
  for (const [dir, i] of importers) {
    out.set(dir, Bun.hash.xxHash3(digests[i]!, seed).toString(16).padStart(16, '0'))
  }
  return out
}
