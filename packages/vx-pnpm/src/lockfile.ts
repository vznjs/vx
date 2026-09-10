// pnpm-lock.yaml → one digest per importer (workspace project) over the
// packages that importer can actually reach: its own dependencies, their
// dependencies, and so on through `snapshots` (v9) or `packages` (v5/v6),
// with `link:` dependencies followed into the linked importer's closure.
// A package's identity is its snapshot key — name, version AND the
// resolved-peer suffix, since `foo@1(react@18)` and `foo@1(react@19)` are
// different node_modules — plus its resolution (integrity / tarball /
// commit) and any patch applied to it. Everything that changes what an
// install produces for EVERY importer (pnpmfile, package extensions,
// overrides, settings) is folded into every digest.
//
// Bun.YAML is the parser: no dependency, and the file is plain YAML.

export interface Lockfile {
  readonly version: string
  /** importer path (`.`, `packages/a`) → dependency name → version or `link:…` */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** snapshot key → dependency name → version (v9 `snapshots`; v5/v6 `packages`) */
  readonly snapshots: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** package key (v9: `name@version`; v5/v6: the snapshot key) → resolution digest */
  readonly resolutions: ReadonlyMap<string, string>
  /** `name` or `name@version` → patch hash */
  readonly patches: ReadonlyMap<string, string>
  /** Material every importer folds: the lockfile version and the install-wide knobs. */
  readonly global: string
}

type Yaml = Record<string, unknown>

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

export function parseLockfile(text: string): Lockfile {
  const doc = Bun.YAML.parse(text) as Yaml | null
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('pnpm-lock.yaml is not a YAML document')
  }
  const version = scalar(doc['lockfileVersion'])
  const major = Number.parseInt(version, 10)
  if (!Number.isFinite(major) || major < 5) {
    throw new Error(`pnpm-lock.yaml: unsupported lockfileVersion ${JSON.stringify(version)}`)
  }

  const importers = new Map<string, ReadonlyMap<string, string>>()
  const rawImporters = record(doc['importers'])
  if (rawImporters !== undefined) {
    for (const [dir, entry] of Object.entries(rawImporters)) importers.set(dir, depsOf(entry))
  } else if (DEP_FIELDS.some((f) => doc[f] !== undefined)) {
    // A single-package lockfile keeps its dependencies at the top level.
    importers.set('.', depsOf(doc))
  }

  const snapshots = new Map<string, ReadonlyMap<string, string>>()
  const resolutions = new Map<string, string>()
  const packages = record(doc['packages']) ?? {}
  for (const [key, entry] of Object.entries(packages)) {
    const e = record(entry) ?? {}
    resolutions.set(key, resolutionOf(e))
    if (major < 9) snapshots.set(key, depsOf(e))
  }
  if (major >= 9) {
    for (const [key, entry] of Object.entries(record(doc['snapshots']) ?? {})) {
      snapshots.set(key, depsOf(entry))
    }
  }

  const patches = new Map<string, string>()
  for (const [name, entry] of Object.entries(record(doc['patchedDependencies']) ?? {})) {
    const e = record(entry)
    patches.set(name, e === undefined ? scalar(entry) : scalar(e['hash']) || stable(e))
  }

  const global = stable({
    lockfileVersion: version,
    settings: doc['settings'],
    overrides: doc['overrides'],
    packageExtensionsChecksum: doc['packageExtensionsChecksum'],
    pnpmfileChecksum: doc['pnpmfileChecksum'],
    ignoredOptionalDependencies: doc['ignoredOptionalDependencies'],
  })
  return { version, importers, snapshots, resolutions, patches, global }
}

/** `dependencies` + `devDependencies` + `optionalDependencies` of an entry, as name → version. */
function depsOf(entry: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  const e = record(entry)
  if (e === undefined) return out
  for (const field of DEP_FIELDS) {
    const deps = record(e[field])
    if (deps === undefined) continue
    for (const [name, v] of Object.entries(deps)) {
      // v6/v9: `{ specifier, version }`; v5 and every snapshot: the version.
      const spec = record(v)
      out.set(name, spec === undefined ? scalar(v) : scalar(spec['version']))
    }
  }
  return out
}

function resolutionOf(entry: Yaml): string {
  const r = record(entry['resolution'])
  return r === undefined ? '' : stable(r)
}

/** A YAML scalar as text; an object or a missing value reads as ''. */
function scalar(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : ''
}

function record(v: unknown): Yaml | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Yaml) : undefined
}

/** JSON with sorted keys, so YAML key order cannot move a digest. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Yaml).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  )
}

/**
 * The snapshot key a dependency `name@version` resolves to, per lockfile
 * generation: `name@1.0.0(peer@2)` (v9), `/name@1.0.0(peer@2)` (v6),
 * `/name/1.0.0_peer@2` (v5). A version that is already a key (`/…`, a
 * `file:…`) is used as it is, and so is an alias (`name: other@1.0.0`)
 * when the lockfile has a snapshot under it.
 */
function snapshotKey(lock: Lockfile, name: string, version: string): string {
  if (version.startsWith('/') || version.startsWith('file:')) return version
  const major = Number.parseInt(lock.version, 10)
  const own =
    major >= 9 ? `${name}@${version}` : major >= 6 ? `/${name}@${version}` : `/${name}/${version}`
  if (lock.snapshots.has(own)) return own
  return lock.snapshots.has(version) ? version : own
}

/** `name@1.0.0(peer@2)` → `name@1.0.0`: the `packages` key a v9 snapshot resolves under. */
function packageKey(snapshot: string): string {
  const paren = snapshot.indexOf('(')
  return paren === -1 ? snapshot : snapshot.slice(0, paren)
}

/** `foo@1.0.0(peer)` / `/foo@1.0.0` → `foo`; `/@s/foo/1.0.0` (v5) → `@s/foo`. */
function packageName(lock: Lockfile, snapshot: string): string {
  let s = packageKey(snapshot)
  if (s.startsWith('/')) s = s.slice(1)
  if (Number.parseInt(lock.version, 10) >= 6) {
    const at = s.indexOf('@', 1)
    return at === -1 ? s : s.slice(0, at)
  }
  const slash = s.lastIndexOf('/')
  return slash === -1 ? s : s.slice(0, slash)
}

/**
 * Every importer's digest, Merkle-style: one hash per node of the graph
 * (importers and snapshots alike) over the node's own material and its
 * children's hashes, so a change anywhere in what an importer reaches
 * moves its digest and a change elsewhere does not. pnpm writes
 * dependency cycles, so the unit is the strongly connected component:
 * Tarjan's walk emits components children-first, each folds its members
 * (sorted) and its child components' hashes (sorted), and the whole file
 * costs O(nodes + edges) — 1000 importers over 3000 packages digest in
 * single-digit milliseconds where one traversal per importer took 400.
 * A `link:` dependency is an edge to the linked importer's node, so what
 * project A can import through workspace package B is B's whole reach.
 */
export function importerDigests(lock: Lockfile): ReadonlyMap<string, string> {
  const g = buildGraph(lock)
  const hashes = componentHashes(g)
  const out = new Map<string, string>()
  const globalSeed = Bun.hash.xxHash3(lock.global)
  for (const dir of lock.importers.keys()) {
    const h = Bun.hash.xxHash3(hashes[g.index.get(importerNode(dir))!]!, globalSeed)
    out.set(dir, h.toString(16).padStart(16, '0'))
  }
  return out
}

interface Graph {
  /** node id → index */
  readonly index: Map<string, number>
  /** what each node folds of its own */
  readonly material: string[]
  /** out-edges, by index */
  readonly edges: number[][]
}

function importerNode(dir: string): string {
  return `importer\0${dir}`
}

function buildGraph(lock: Lockfile): Graph {
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
  for (const key of lock.snapshots.keys()) {
    const resolution = lock.resolutions.get(key) ?? lock.resolutions.get(packageKey(key)) ?? ''
    const patch =
      lock.patches.get(packageKey(key)) ?? lock.patches.get(packageName(lock, key)) ?? ''
    node(key, `${key}\0${resolution}\0${patch}`)
  }
  for (const dir of lock.importers.keys()) node(importerNode(dir), 'importer')
  const link = (from: number, dir: string, name: string, version: string): void => {
    if (version.startsWith('link:')) {
      const target = joinPosix(dir, version.slice('link:'.length))
      if (lock.importers.has(target)) edges[from]!.push(index.get(importerNode(target))!)
      else material[from] += `\nlink\0${name}\0${version}`
      return
    }
    const key = snapshotKey(lock, name, version)
    // A dependency with no snapshot (a leaf the file lists only by version)
    // is a node of its own, so its version still counts.
    edges[from]!.push(node(key, `${key}\0${lock.resolutions.get(packageKey(key)) ?? ''}\0`))
  }
  for (const [dir, deps] of lock.importers) {
    const from = index.get(importerNode(dir))!
    for (const [name, version] of deps) link(from, dir, name, version)
  }
  for (const [key, deps] of lock.snapshots) {
    const from = index.get(key)!
    for (const [name, version] of deps) link(from, '.', name, version)
  }
  return { index, material, edges }
}

/**
 * Tarjan's SCC, iterative (a pnpm graph can be thousands deep), emitting
 * components children-first; each is hashed as it is emitted, so every
 * child hash exists by the time a parent folds it. Returns one hash per
 * node (its component's).
 */
function componentHashes(g: Graph): string[] {
  const n = g.material.length
  const idx = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  const comp = new Int32Array(n).fill(-1)
  const compHash: string[] = []
  let counter = 0
  for (let root = 0; root < n; root++) {
    if (idx[root] !== -1) continue
    // Frames of [node, next edge position]; the explicit stack replaces
    // recursion.
    const frames: Array<[number, number]> = [[root, 0]]
    idx[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = 1
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      const v = frame[0]
      const out = g.edges[v]!
      if (frame[1] < out.length) {
        const w = out[frame[1]++]!
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          frames.push([w, 0])
        } else if (onStack[w] === 1) {
          low[v] = Math.min(low[v]!, idx[w]!)
        }
        continue
      }
      frames.pop()
      if (frames.length > 0) {
        const u = frames[frames.length - 1]![0]
        low[u] = Math.min(low[u]!, low[v]!)
      }
      if (low[v] !== idx[v]) continue
      // v is a component root: pop its members and hash the component.
      const members: number[] = []
      for (;;) {
        const w = stack.pop()!
        onStack[w] = 0
        comp[w] = compHash.length
        members.push(w)
        if (w === v) break
      }
      const id = compHash.length
      const children = new Set<string>()
      for (const m of members) {
        for (const w of g.edges[m]!) if (comp[w] !== id) children.add(compHash[comp[w]!]!)
      }
      let h = Bun.hash.xxHash3(`members:${members.length}`)
      for (const m of members.map((m) => g.material[m]!).sort()) h = Bun.hash.xxHash3(`${m}\n`, h)
      h = Bun.hash.xxHash3(`children:${children.size}`, h)
      for (const c of [...children].sort()) h = Bun.hash.xxHash3(`${c}\n`, h)
      compHash.push(h.toString(16).padStart(16, '0'))
    }
  }
  return Array.from({ length: n }, (_, i) => compHash[comp[i]!]!)
}

/** `packages/a` + `../b` → `packages/b`; `.` + `packages/a` → `packages/a`. POSIX, as the lockfile writes paths. */
function joinPosix(base: string, rel: string): string {
  const parts: string[] = []
  for (const seg of `${base}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.length === 0 ? '.' : parts.join('/')
}
