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
/** The top-level fields the digest reads per workspace. */
const PER_WORKSPACE = new Set(['workspaces', 'packages'])

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
  // Every top-level field but the two read per workspace, so a field this
  // parser has not heard of moves every workspace rather than none: an
  // allow-list dropped `trustedDependencies`, which decides whose install
  // scripts run (item 933).
  const rest: Json = {}
  for (const [k, v] of Object.entries(d)) if (!PER_WORKSPACE.has(k)) rest[k] = v
  const global = JSON.stringify(rest)
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
  // A scoped name (`@s/x`) is one level at ANY depth: `foo/@s/y` → `foo` →
  // ''. Only a root-level scope was joined, so `foo/@s/y` stepped to
  // `foo/@s` and its `bar` resolved to `foo/@s/bar`, another package
  // (`@s/bar`); the root `bar` it installs was never folded (item 901).
  const levels = packageLevels(from)
  for (let n = levels.length; ; n--) {
    const base = levels.slice(0, n).join('/')
    const key = base === '' ? name : `${base}/${name}`
    if (lock.packages.has(key)) return key
    if (n === 0) return undefined
  }
}

/** A node_modules path's package levels: `foo/@s/y/z` → foo, @s/y, z. */
function packageLevels(path: string): string[] {
  if (path === '') return []
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    out.push(part.startsWith('@') && i + 1 < parts.length ? `${part}/${parts[++i]}` : part)
  }
  return out
}

/**
 * The patch files `patchedDependencies` names. bun.lock records a patch by
 * PATH, never by a hash of its content, so an edited patch left the lockfile
 * byte-identical and every key unmoved while the install applied the new
 * one (item 1014): the claim hashes these files and hands them back.
 */
export function patchFiles(text: string): string[] {
  const d = record(Bun.JSONC.parse(text))
  return Object.values(record(d?.['patchedDependencies']) ?? {}).filter(
    (v): v is string => typeof v === 'string',
  )
}

/**
 * Every workspace package's digest (by dir): the lockfile as one graph —
 * a node per node_modules path, its material the id + resolution, an edge
 * per resolved dependency — folded by core's `reachDigests`. A workspace
 * dependency (`workspace:` id) is a node like any other, so what project
 * A can import through workspace package B is B's whole reach.
 */
export function importerDigests(
  lock: Lockfile,
  files: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
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
  // The name a package is installed under and what it is, not where: a
  // re-hoist (`is-odd/is-number` → `is-number`, one version) re-keyed
  // every project reaching it with the same bytes installed (D-140). Where
  // it sits still decides what it resolves; that is the edges.
  for (const [p, e] of lock.packages) node(p, `${installName(p)}\0${e.id}\0${e.resolution}`)
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
    // Its dir, as pnpm's importers fold theirs (item 1073).
    const own = node(`workspace\0${dir}`, `workspace\0${dir}`)
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
  // The global digest rides as DATA: Bun's xxHash3 reads only the low 32
  // bits of a seed, so two lockfiles' globals could share one (item 682).
  // A patch's content beside its path; nothing added without one, so a
  // lockfile with no patches keys as it did.
  const patches = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const globalMaterial =
    patches.length === 0 ? lock.global : `${lock.global}\0${JSON.stringify(patches)}`
  const global = Bun.hash.xxHash3(globalMaterial).toString(16).padStart(16, '0')
  for (const [dir, i] of importers) {
    out.set(dir, Bun.hash.xxHash3(`${global}\0${digests[i]!}`).toString(16).padStart(16, '0'))
  }
  return out
}

/** The name a package key installs under: its last segment, scope included. */
function installName(key: string): string {
  const parts = key.split('/')
  const scoped = parts.length >= 2 && parts[parts.length - 2]!.startsWith('@')
  return scoped ? parts.slice(-2).join('/') : parts[parts.length - 1]!
}
