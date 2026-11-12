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
import { type LockfileImporter, reachedImporters, withTransitive } from './graph.js'
import { depsOf, peerOnly, record, sectionsOf, stable, type Json } from './json.js'
import { joinPosix, resolvePosix } from './posix.js'

// The graph the digest built from this parse, for `importerLinks`: `vx
// lock` asks for both, and the edges do not depend on `files`.
const built = new WeakMap<Lockfile, ReturnType<typeof buildGraph>>()

export interface Lockfile {
  readonly version: string
  /** root-relative dir (`.` for the root) → dependency name → specifier */
  readonly workspaces: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** root-relative dir → which field each dependency sits in (`sectionsOf`) */
  readonly workspaceSections: ReadonlyMap<string, string>
  /** workspace package name → its dir */
  readonly workspaceDirs: ReadonlyMap<string, string>
  /** non-root workspace dir → its own `version`, which `bun pm pack` writes for a dependent's `workspace:` range */
  readonly workspaceVersions: ReadonlyMap<string, string>
  /** root-relative dir → its installed dependencies (`dependencies` win, as Bun 1.4 installs them) */
  readonly workspaceInstalled: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** root-relative dir → the peers it installs no entry for */
  readonly workspacePeers: ReadonlyMap<string, ReadonlySet<string>>
  /** node_modules path → the package there */
  readonly packages: ReadonlyMap<string, Entry>
  /** `patchedDependencies`: `name@version` (or `name`) → the patch file's path */
  readonly patches: ReadonlyMap<string, string>
  /** Material every workspace folds: the lockfile version and install-wide knobs. */
  readonly global: string
}

export interface Entry {
  /** `name@version`, `name@workspace:dir`, `name@github:…` */
  readonly id: string
  readonly deps: ReadonlyMap<string, string>
  /** the `peerDependencies` it installs under no other field */
  readonly peers: ReadonlySet<string>
  /** integrity / commit — whatever pins the bytes */
  readonly resolution: string
  /** shipped inside its parent's tarball (`bundleDependencies`), not installed from this entry */
  readonly bundled: boolean
}

/** The top-level fields the digest reads per workspace. */
// Read per workspace: the workspaces and packages themselves, and the fields
// whose whole effect is the `packages` entry a workspace reaches — how a
// range was written (catalogs, D-141), what an override forced (D-142) and
// what a patch changed (D-143). Folded into every workspace, one such edit
// re-keyed them all.
const PER_WORKSPACE = new Set([
  'workspaces',
  'packages',
  'catalog',
  'catalogs',
  'overrides',
  'patchedDependencies',
])

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
  const workspaceSections = new Map<string, string>()
  const workspaceDirs = new Map<string, string>()
  const workspaceVersions = new Map<string, string>()
  const workspaceInstalled = new Map<string, ReadonlyMap<string, string>>()
  const workspacePeers = new Map<string, ReadonlySet<string>>()
  for (const [dir, manifest] of Object.entries(record(d['workspaces']) ?? {})) {
    const m = record(manifest) ?? {}
    const key = dir === '' ? '.' : dir
    workspaces.set(key, depsOf(m))
    workspaceSections.set(key, sectionsOf(m))
    workspaceInstalled.set(
      key,
      depsOf(m, ['devDependencies', 'optionalDependencies', 'dependencies']),
    )
    workspacePeers.set(key, peerOnly(m))
    if (typeof m['name'] === 'string') workspaceDirs.set(m['name'], key)
    // The root's is in every key and packs into none: a release bump of it
    // would re-key every task with node_modules unchanged.
    if (key !== '.' && typeof m['version'] === 'string') workspaceVersions.set(key, m['version'])
  }
  const packages = new Map<string, Entry>()
  for (const [p, tuple] of Object.entries(record(d['packages']) ?? {})) {
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string') continue
    const meta = tuple.find((v) => record(v) !== undefined)
    const resolution = tuple.slice(1).findLast((v) => typeof v === 'string' && v.length > 0)
    packages.set(p, {
      id: tuple[0],
      deps: depsOf(record(meta) ?? {}),
      peers: peerOnly(record(meta) ?? {}),
      resolution: typeof resolution === 'string' ? resolution : '',
      bundled: record(meta)?.['bundled'] === true,
    })
  }
  // Every top-level field but the two read per workspace, so a field this
  // parser has not heard of moves every workspace rather than none: an
  // allow-list dropped `trustedDependencies`, which decides whose install
  // scripts run (item 933).
  const rest: Json = {}
  for (const [k, v] of Object.entries(d)) if (!PER_WORKSPACE.has(k)) rest[k] = v

  const patches = new Map<string, string>()
  for (const [k, v] of Object.entries(record(d['patchedDependencies']) ?? {})) {
    patches.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  // Sorted: the order Bun writes the fields in says nothing of the install.
  const global = stable(rest)
  return {
    version: String(d['lockfileVersion']),
    workspaces,
    workspaceSections,
    workspaceDirs,
    workspaceVersions,
    workspaceInstalled,
    workspacePeers,
    packages,
    patches,
    global,
  }
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
 * Each workspace's dependencies that resolve to a `workspace:` package: an
 * installed entry is a dep, a peer with none of the same name a peer. A
 * `workspace:` path or alias (`workspace:../b`, `workspace:@s/b@^1`) names
 * its target, which Bun links though `packages` holds no nested entry for
 * it, and so does an `npm:` alias no entry installs under its own name (a
 * satisfied one: Bun links the workspace package); anything else resolves
 * through Bun's layout. A workspace a package it installs resolves to is
 * `transitive`.
 */
export function importerLinks(lock: Lockfile): ReadonlyMap<string, LockfileImporter> {
  const out = new Map<string, LockfileImporter>()
  const g = built.get(lock) ?? buildGraph(lock, new Map())
  const nodes = new Map<number, string>()
  for (const [dir, i] of g.importers) nodes.set(i, dir)
  for (const [p, e] of lock.packages) {
    const dir = workspaceOf(lock, e.id)
    if (dir !== undefined && g.importers.has(dir)) nodes.set(g.index.get(p)!, dir)
  }
  const reached = reachedImporters(g.edges, nodes)
  const viaLayout = (from: string, name: string): string | undefined => {
    const key = resolve(lock, from, name)
    return key === undefined ? undefined : workspaceOf(lock, lock.packages.get(key)!.id)
  }
  for (const dir of lock.workspaces.keys()) {
    const from = importerFrom(lock, dir)
    const links = { deps: {} as Record<string, string>, peers: {} as Record<string, string> }
    const add = (kind: 'deps' | 'peers', name: string, target: string | undefined): void => {
      if (target !== undefined && target !== dir && lock.workspaces.has(target)) {
        links[kind][name] = target
      }
    }
    for (const [name, spec] of lock.workspaceInstalled.get(dir)!) {
      add('deps', name, workspaceSpecTarget(lock, dir, from, name, spec) ?? viaLayout(from, name))
    }
    for (const name of lock.workspacePeers.get(dir)!) add('peers', name, viaLayout(from, name))
    out.set(dir, withTransitive(links, reached.get(dir)))
  }
  return out
}

const ALIAS = /^(@[^@/]+\/[^@/]+|[^@/.][^@/]*)(?:@.*)?$/

/**
 * The workspace dir a spec names past Bun's layout: `workspace:<path>`,
 * `workspace:<name>@<range>`, or `npm:<name>@<range>` when the entry the
 * dependency resolves to is not a `<name>` package.
 */
function workspaceSpecTarget(
  lock: Lockfile,
  dir: string,
  from: string,
  key: string,
  spec: string,
): string | undefined {
  if (spec.startsWith('npm:')) {
    const alias = ALIAS.exec(spec.slice('npm:'.length))?.[1]
    const at = resolve(lock, from, key)
    if (alias === undefined || lock.packages.get(at ?? '')?.id.startsWith(`${alias}@`)) {
      return undefined
    }
    return lock.workspaceDirs.get(alias)
  }
  if (!spec.startsWith('workspace:')) return undefined
  const rest = spec.slice('workspace:'.length)
  if (rest.startsWith('/')) return undefined
  if (rest.startsWith('.')) return joinPosix(dir, rest)
  const alias = ALIAS.exec(rest)
  return alias === null ? undefined : lock.workspaceDirs.get(alias[1]!)
}

/**
 * The workspace dir a package id installs: `b@workspace:packages/b`, the
 * root, which Bun 1.4 writes `root@root:`, or a `link:` to a workspace's
 * directory (`b@link:./packages/b`), which symlinks the workspace itself:
 * read as a leaf, b's bumps moved no key of the project linking it.
 */
function workspaceOf(lock: Lockfile, id: string): string | undefined {
  const at = id.indexOf('@workspace:', 1)
  if (at !== -1) return id.slice(at + '@workspace:'.length) || '.'
  if (id.endsWith('@root:')) return '.'
  const link = id.indexOf('@link:', 1)
  if (link === -1 || globalLink(id.slice(link + '@link:'.length))) return undefined
  const dir = joinPosix('.', id.slice(link + '@link:'.length))
  return dir !== undefined && lock.workspaces.has(dir) ? dir : undefined
}

/**
 * The node_modules path a workspace resolves from: its own name, `./<name>`
 * when a root package holds that name, or the root's ''. Bun 1.4 writes no
 * root entry for such a workspace and nests its own dependencies under
 * `./<name>/`: resolved from `<name>`, they were the root package's.
 */
function importerFrom(lock: Lockfile, dir: string): string {
  if (dir === '.') return ''
  // Each workspace asks: a scan of every name per ask was quadratic, 33 ms
  // of a 1,000-workspace install check.
  let names = namesByDir.get(lock)
  if (names === undefined) {
    names = new Map()
    for (const [name, wsDir] of lock.workspaceDirs) if (!names.has(wsDir)) names.set(wsDir, name)
    namesByDir.set(lock, names)
  }
  const name = names.get(dir)
  if (name === undefined) return ''
  const held = lock.packages.get(name)
  return held === undefined || held.id === `${name}@workspace:${dir}` ? name : `./${name}`
}
const namesByDir = new WeakMap<Lockfile, Map<string, string>>()

/**
 * The registry version each workspace's dependencies resolve to, as the
 * lockfile names it: workspace dir → dependency name → version. A
 * `workspace:`, git, tarball or `file:` dependency names no version and is
 * left out.
 */
export function directVersions(lock: Lockfile): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  for (const [dir, deps] of lock.workspaceInstalled) {
    const from = importerFrom(lock, dir)
    const versions = new Map<string, string>()
    for (const name of deps.keys()) {
      const key = resolve(lock, from, name)
      const version = registryVersion(key === undefined ? undefined : lock.packages.get(key)?.id)
      if (version !== undefined) versions.set(name, version)
    }
    out.set(dir, versions)
  }
  return out
}

/** A registry package id's version (`is-number@7.0.0` → 7.0.0); none for any other id. */
function registryVersion(id: string | undefined): string | undefined {
  const version = id?.slice(id.indexOf('@', 1) + 1)
  return version !== undefined && /^\d+\.\d+\.\d+/.test(version) ? version : undefined
}

/**
 * Where the hoisted linker puts each registry package the lockfile lists:
 * root-relative dir → version. Key `p/d` nests `d` in `p`'s own
 * `node_modules`, a workspace's through the root's link to it, and
 * `./<name>/d` in that workspace's.
 */
export function hoistedVersions(lock: Lockfile): Map<string, string> {
  // A tarball's bundled packages are its own, nested ones too: npm 11.21
  // ships @sigstore/protobuf-specs 0.5.1 where bun.lock names 0.5.2.
  const bundlers = new Set<string>()
  for (const [p, e] of lock.packages) {
    if (e.bundled) bundlers.add(packageLevels(p).slice(0, -1).join('/'))
  }
  const out = new Map<string, string>()
  for (const [p, e] of lock.packages) {
    const version = registryVersion(e.id)
    if (version === undefined) continue
    const levels0 = packageLevels(p)
    if (levels0.some((_, i) => i > 0 && bundlers.has(levels0.slice(0, i).join('/')))) continue
    let base = ''
    let levels = levels0
    if (p.startsWith('./')) {
      const dir = lock.workspaceDirs.get(levels[1]!)
      if (dir === undefined) continue
      base = `${dir}/`
      levels = levels.slice(2)
    }
    out.set(base + levels.map((l) => `node_modules/${l}`).join('/'), version)
  }
  return out
}

/**
 * The isolated linker's links, by package id: `name@version` → dependency
 * name → the ids the lockfile resolves it to from any key holding that
 * package. Peers are left out: each store copy links its own.
 */
export function storeLinks(lock: Lockfile): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>()
  for (const [p, e] of lock.packages) {
    if (registryVersion(e.id) === undefined) continue
    let deps = out.get(e.id)
    if (deps === undefined) out.set(e.id, (deps = new Map()))
    for (const name of e.deps.keys()) {
      if (e.peers.has(name)) continue
      const key = resolve(lock, p, name)
      const id = key === undefined ? undefined : lock.packages.get(key)!.id
      if (registryVersion(id) === undefined) continue
      let ids = deps.get(name)
      if (ids === undefined) deps.set(name, (ids = new Set()))
      ids.add(id!)
    }
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
 * The root-relative paths of `file:` and `link:` dependencies
 * (`dep@file:vendor/dep`, `dep@link:./vendor/dep`). Bun copies the first
 * at install and links the second, recording only the path, so an edit in
 * either moved no key (Growth, file-dir-dep-stale.sh): the claim hashes
 * its content like a patch's. A link to a workspace is that workspace's
 * node, not its files.
 */
export function fileDeps(lock: Lockfile): string[] {
  const out = new Set<string>()
  for (const [p, e] of lock.packages) for (const dir of fileDirs(lock, p, e.id)) out.add(dir)
  return [...out].sort()
}

/**
 * `dep@file:vendor/dep` → `vendor/dep`; `dep@link:./vendor/dep` →
 * `vendor/dep` unless a workspace. A `bun link` link (`gdep@link:gdep`, a
 * name, never a path: bun.lock writes a path `./`-led) points into the
 * user's global store, outside the repo: read as `./gdep`, it hashed
 * nothing. Its symlinks in node_modules name what the install linked,
 * where the hoisted linker (the root) or the isolated one (each workspace
 * asking for it) puts them; one absent hashes as none until it is there.
 */
function fileDirs(lock: Lockfile, p: string, id: string): string[] {
  const file = id.indexOf('@file:', 1)
  if (file !== -1) return [id.slice(file + '@file:'.length)]
  const link = id.indexOf('@link:', 1)
  if (link === -1) return []
  const rest = id.slice(link + '@link:'.length)
  if (globalLink(rest)) {
    const out = new Set([`node_modules/${installName(p)}`])
    for (const [dir, deps] of lock.workspaces) {
      for (const [name, spec] of deps) {
        if (spec === `link:${rest}`) out.add(joinPosix(dir, `node_modules/${name}`)!)
      }
    }
    return [...out].sort()
  }
  const dir = resolvePosix('.', rest)
  return lock.workspaces.has(dir) ? [] : [dir]
}

/** A `link:` to a name in Bun's global link store, not a path. */
function globalLink(rest: string): boolean {
  return /^(?:@[^/]+\/)?[^/.][^/]*$/.test(rest)
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
  const g = buildGraph(lock, files)
  built.set(lock, g)
  const { material, edges, importers, loose } = g
  const digests = reachDigests({ material, edges })
  const out = new Map<string, string>()
  // The global digest rides as DATA: Bun's xxHash3 reads only the low 32
  // bits of a seed, so two lockfiles' globals could share one (item 682).
  const globalMaterial =
    loose.length === 0 ? lock.global : `${lock.global}\0${JSON.stringify(loose)}`
  const global = Bun.hash.xxHash3(globalMaterial).toString(16).padStart(16, '0')
  for (const [dir, i] of importers) {
    out.set(dir, Bun.hash.xxHash3(`${global}\0${digests[i]!}`).toString(16).padStart(16, '0'))
  }
  return out
}

/** The lockfile as one graph, each importer's node by dir, and the patches naming no entry. */
function buildGraph(
  lock: Lockfile,
  files: ReadonlyMap<string, string>,
): {
  index: Map<string, number>
  material: string[]
  edges: number[][]
  importers: Map<string, number>
  loose: [string, string, string][]
} {
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
    for (const dir of fileDirs(lock, p, e.id))
      material[index.get(p)!] += `\nfile\0${files.get(dir) ?? ''}`
  }
  // A patch is part of the package it patches: an edit to one only `b`
  // reaches re-keyed every workspace while it was install-wide (D-143).
  // One that names no entry stays install-wide, so it still moves a key.
  const loose: [string, string, string][] = []
  for (const [key, file] of [...lock.patches].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const own = `\npatch\0${key}\0${file}\0${files.get(file) ?? ''}`
    let hit = false
    for (const [p, e] of lock.packages) {
      if (e.id !== key && e.id.slice(0, e.id.lastIndexOf('@')) !== key) continue
      material[index.get(p)!] += own
      hit = true
    }
    if (!hit) loose.push([key, file, files.get(file) ?? ''])
  }
  // Bun's isolated linker (the default for a workspace whose bun.lock
  // says `configVersion: 1`) links a peer from its store, not by this
  // walk: c's `react` peer was b's nested react@19.0.0 while the walk
  // found the root's 18.3.1, so b's react bump moved no key of c (probed,
  // bun 1.4.4). A peer folds every installed copy of its name.
  const copies = new Map<string, number[]>()
  for (const [p, i] of index) {
    const name = installName(p)
    const list = copies.get(name)
    if (list === undefined) copies.set(name, [i])
    else list.push(i)
  }
  const peerCopies = (from: number, peers: ReadonlySet<string>): void => {
    for (const name of peers) for (const i of copies.get(name) ?? []) edges[from]!.push(i)
  }
  for (const [p, e] of lock.packages) {
    const from = index.get(p)!
    for (const [name, spec] of e.deps) {
      const target = resolve(lock, p, name)
      if (target !== undefined) edges[from]!.push(index.get(target)!)
      else material[from] += `\nunresolved\0${name}\0${spec}`
    }
    peerCopies(from, e.peers)
  }
  // A workspace importer resolves like the package at its own name; the
  // root importer ('') resolves from the root.
  const importers = new Map<string, number>()
  for (const [dir, deps] of lock.workspaces) {
    // Its dir, as pnpm's importers fold theirs (item 1073).
    // And its version: `bun pm pack` writes it in place of a dependent's
    // `workspace:*`, so a bump left the dependent's tarball replayed.
    const own = node(
      `workspace\0${dir}`,
      `workspace\0${dir}\nsections\0${lock.workspaceSections.get(dir)}\nversion\0${lock.workspaceVersions.get(dir) ?? ''}`,
    )
    importers.set(dir, own)
    const from = importerFrom(lock, dir)
    for (const [name, spec] of deps) {
      const target = resolve(lock, from, name)
      if (target !== undefined) edges[own]!.push(index.get(target)!)
      else material[own] += `\nunresolved\0${name}\0${spec}`
    }
    peerCopies(own, lock.workspacePeers.get(dir)!)
  }
  // A workspace package's node carries no dependencies of its own — they
  // live on its importer — so the node points at the importer: what a
  // project can import through workspace package B is B's whole reach.
  for (const [p, e] of lock.packages) {
    const dir = workspaceOf(lock, e.id)
    const target = dir === undefined ? undefined : importers.get(dir)
    if (target !== undefined) edges[index.get(p)!]!.push(target)
  }
  return { index, material, edges, importers, loose }
}

/** The name a package key installs under: its last segment, scope included. */
function installName(key: string): string {
  const parts = key.split('/')
  const scoped = parts.length >= 2 && parts[parts.length - 2]!.startsWith('@')
  return scoped ? parts.slice(-2).join('/') : parts[parts.length - 1]!
}
