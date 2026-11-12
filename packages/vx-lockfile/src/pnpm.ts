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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { reachDigests } from '@vzn/vx'
import { type LockfileImporter, reachedImporters, withTransitive } from './graph.js'
import { record, sectionsOf, stable } from './json.js'
import { topLevel } from './pnpm-blocks.js'
import { joinPosix, resolvePosix } from './posix.js'

// The graph the digest built from this parse, for `importerLinks`: `vx
// lock` asks for both, and the edges do not depend on `files`.
const built = new WeakMap<Lockfile, ReturnType<typeof buildGraph>>()

export interface Lockfile {
  readonly version: string
  /** importer path (`.`, `packages/a`) → dependency name → version or `link:…` */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** importer path → which field each dependency sits in (`sectionsOf`) */
  readonly sections: ReadonlyMap<string, string>
  /** an importer's `publishDirectory` (root-relative) → the importer */
  readonly published: ReadonlyMap<string, string>
  /** snapshot key → dependency name → version (v9 `snapshots`; v5/v6 `packages`) */
  readonly snapshots: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** package key (v9: `name@version`; v5/v6: the snapshot key) → resolution digest */
  readonly resolutions: ReadonlyMap<string, string>
  /** `name` or `name@version` → patch hash */
  readonly patches: ReadonlyMap<string, string>
  /** package key → the root-relative directory a `file:` dependency installs from */
  readonly directories: ReadonlyMap<string, string>
  /** Material every importer folds: the lockfile version and the install-wide knobs. */
  readonly global: string
  /** `settings.excludeLinksFromLockfile`: no importer records its `link:` dependencies. */
  readonly excludesLinks: boolean
}

type Yaml = Record<string, unknown>

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/**
 * The top-level fields the digest reads per importer: the importers, the
 * packages and snapshots they reach, their patches, and the catalogs their
 * specifiers resolved. `overrides` too: what an override did is the
 * snapshot an importer now reaches, and folded into every digest one
 * override that only `b` reached re-keyed `a` and the root as well (probed
 * on pnpm 9, D-142). (v5's lone importer, written at the top, may fold as
 * global too: it is the only importer there is.)
 */
const PER_IMPORTER = new Set([
  'importers',
  'packages',
  'snapshots',
  'patchedDependencies',
  'catalogs',
  'overrides',
])

export function parseLockfile(text: string): Lockfile {
  // pnpm 10.x and 11 write the env lockfile (`configDependencies`, the
  // package manager's own install) as a leading YAML document; the
  // project lockfile is the last one, as Turbo reads it. Read as one
  // document, the pair was an array and every such repo was refused
  // with "regenerate it", which regenerates the same two documents.
  const parsed: unknown = Bun.YAML.parse(text)
  const docs = (Array.isArray(parsed) ? parsed : [parsed]).filter((d) => d !== null)
  const doc = record(docs.at(-1))
  const leading = docs.slice(0, -1)
  if (doc === undefined) throw new Error('pnpm-lock.yaml: not a YAML document')
  const version = scalar(doc['lockfileVersion'])
  const major = Number.parseInt(version, 10)
  if (!Number.isFinite(major) || major < 5) {
    throw new Error(`pnpm-lock.yaml: unsupported lockfileVersion ${JSON.stringify(version)}`)
  }

  const importers = new Map<string, ReadonlyMap<string, string>>()
  const sections = new Map<string, string>()
  const published = new Map<string, string>()
  const rawImporters = record(doc['importers'])
  if (rawImporters !== undefined) {
    for (const [dir, entry] of Object.entries(rawImporters)) {
      importers.set(dir, depsOf(entry))
      sections.set(dir, sectionsOf(record(entry) ?? {}, DEP_FIELDS))
      // `publishConfig.directory` with `linkDirectory`: a dependant's
      // `link:` names this directory, and it is the importer.
      const publishDir = record(entry)?.['publishDirectory']
      if (typeof publishDir === 'string') {
        const at = joinPosix(dir, publishDir)
        if (at !== undefined && at !== dir) published.set(at, dir)
      }
    }
  } else if (DEP_FIELDS.some((f) => doc[f] !== undefined)) {
    // A single-package lockfile keeps its dependencies at the top level.
    importers.set('.', depsOf(doc))
    sections.set('.', sectionsOf(doc, DEP_FIELDS))
  }

  const snapshots = new Map<string, ReadonlyMap<string, string>>()
  const resolutions = new Map<string, string>()
  const directories = new Map<string, string>()
  const packages = record(doc['packages']) ?? {}
  for (const [key, entry] of Object.entries(packages)) {
    const e = record(entry) ?? {}
    resolutions.set(key, resolutionOf(e))
    const r = record(e['resolution'])
    if (r?.['type'] === 'directory' && typeof r['directory'] === 'string') {
      directories.set(key, r['directory'])
    }
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

  // Every top-level field but those read per importer above, so a field
  // this parser has not heard of moves every importer rather than none: an
  // allow-list dropped v6's `onlyBuiltDependencies`, which decides whether
  // install scripts run anywhere (item 933).
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) if (!PER_IMPORTER.has(k)) rest[k] = v
  // The env lockfile moves every importer: a config dependency can carry
  // the pnpmfile that rewrites every install, and the package manager's
  // own version installs all of them. Folded only when present, so a
  // one-document lockfile keys as it did.
  const global = stable(
    leading.length === 0
      ? { lockfileVersion: version, rest }
      : { lockfileVersion: version, rest, leading },
  )
  const excludesLinks = record(doc['settings'])?.['excludeLinksFromLockfile'] === true
  return {
    version,
    importers,
    sections,
    published,
    snapshots,
    resolutions,
    patches,
    directories,
    global,
    excludesLinks,
  }
}

/**
 * The importers' dependencies alone, as `parseLockfile` reads them. The
 * staleness check asks for them on every run, after the digest memo spared
 * the parse: solid's 6,900-line lockfile took 8 ms to parse whole and
 * 0.4 ms for its `importers` block. Sliced from the last document to the
 * next top-level key; any other shape is parsed whole.
 */
export function recordedImporters(text: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const rawImporters = record(topLevel(text, 'importers'))
  if (rawImporters === undefined) return parseLockfile(text).importers
  const importers = new Map<string, ReadonlyMap<string, string>>()
  for (const [dir, entry] of Object.entries(rawImporters)) importers.set(dir, depsOf(entry))
  return importers
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

/**
 * The snapshot key a dependency `name@version` resolves to, per lockfile
 * generation: `name@1.0.0(peer@2)` (v9), `/name@1.0.0(peer@2)` (v6),
 * `/name/1.0.0_peer@2` (v5). A version that is already a key (`/…`) is
 * used as it is. Otherwise the generation's own key comes first, then
 * the version itself when the lockfile has a snapshot under it: an alias
 * (`name: other@1.0.0`), and a v5/v6 `file:…`, whose key is the bare
 * version. A v9 `file:…` is keyed `name@file:…` like any other, and
 * taking the version first made it a leaf: a bump behind a directory
 * dependency moved no digest (item 802).
 */
export function snapshotKey(lock: Lockfile, name: string, version: string): string {
  if (version.startsWith('/')) return version
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
 * The patch pnpm applies to a snapshot, by its precedence: `name@version`,
 * then a range key (`name@<=7.0.0`), then `name`. A range key matched
 * nothing here, so a patch edit re-keyed no project (vercel/turborepo#13307).
 */
function patchOf(lock: Lockfile, snapshot: string): string {
  const exact = lock.patches.get(packageKey(snapshot))
  if (exact !== undefined) return exact
  const name = packageName(lock, snapshot)
  const id = packageKey(snapshot)
  const version = id.slice(id.indexOf(name) + name.length + 1)
  for (const [key, hash] of lock.patches) {
    if (key.length > name.length + 1 && key.startsWith(`${name}@`)) {
      const range = key.slice(name.length + 1)
      if (Bun.semver.satisfies(version, range)) return hash
    }
  }
  return lock.patches.get(name) ?? ''
}

/**
 * Every importer's digest: the lockfile as one graph (importers and
 * snapshots alike), each node's material its identity, and core's
 * `reachDigests` folding what every node reaches (components, so pnpm's
 * cycles terminate). A `link:` dependency is an edge to the linked
 * importer's node, so what project A can import through workspace
 * package B is B's whole reach. `hoisted` (`nodeLinker: hoisted`) folds
 * every peer variant of a package into each (`withVariants`).
 */
export function importerDigests(
  lock: Lockfile,
  files: ReadonlyMap<string, string> = new Map(),
  hoisted = false,
): ReadonlyMap<string, string> {
  const g = buildGraph(lock, files)
  built.set(lock, g)
  const hashes = reachDigests(hoisted ? withVariants(lock, g) : g)
  const out = new Map<string, string>()
  // The global digest rides as DATA: Bun's xxHash3 reads only the low 32
  // bits of a seed, so two lockfiles' globals could share one (item 682).
  const global = Bun.hash.xxHash3(lock.global).toString(16).padStart(16, '0')
  const reachOf = (dir: string): string => hashes[g.index.get(importerNode(dir))!]!
  // With its links left out, the file does not say which importer links
  // which, so each folds them all: keyed by its own reach, a project
  // linking another missed a bump in the linked one's dependencies.
  // The directories its manifests link (`manifestLinks`) join them too:
  // the file names none of them.
  const all = lock.excludesLinks
    ? [
        ...[...lock.importers.keys()].sort().map(reachOf),
        ...[...files]
          .filter(([rel]) => !MANIFESTS.includes(path.posix.basename(rel)))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([rel, h]) => `${rel}\0${h}`),
      ].join('\0')
    : undefined
  for (const dir of lock.importers.keys()) {
    const h = Bun.hash.xxHash3(`${global}\0${all ?? reachOf(dir)}`)
    out.set(dir, h.toString(16).padStart(16, '0'))
  }
  return out
}

/**
 * `g` with each package's peer variants (`foo@1(react@18)`,
 * `foo@1(react@19)`) reaching one another. The hoisted linker installs
 * one copy per `name@version` with whichever variant's dependencies it
 * placed first, so b's `foo@1(react@19)` loaded a's react@18 and a's
 * react bump moved no key of b. A copy, so `importerLinks` reads the
 * lockfile's own edges.
 */
function withVariants(lock: Lockfile, g: Graph): Pick<Graph, 'material' | 'edges'> {
  const groups = new Map<string, number[]>()
  for (const key of lock.snapshots.keys()) {
    const id = variantOf(lock, key)
    const list = groups.get(id)
    if (list === undefined) groups.set(id, [g.index.get(key)!])
    else list.push(g.index.get(key)!)
  }
  const material = [...g.material]
  const edges = g.edges.map((e) => [...e])
  for (const [id, members] of groups) {
    if (members.length < 2) continue
    // One node the variants share, not an edge per pair.
    const hub = material.length
    material.push(`variants\0${id}`)
    edges.push(members)
    for (const m of members) edges[m]!.push(hub)
  }
  return { material, edges }
}

/** A snapshot key without its peers: `foo@1(react@18)` (v6, v9) or `/foo/1_react@18` (v5) → `foo@1`, `/foo/1`. */
function variantOf(lock: Lockfile, snapshot: string): string {
  const id = packageKey(snapshot)
  if (Number.parseInt(lock.version, 10) >= 6) return id
  const underscore = id.indexOf('_', id.lastIndexOf('/') + 1)
  return underscore === -1 ? id : id.slice(0, underscore)
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

/**
 * The directories `file:` dependencies install from, and those a `link:`
 * names that is no importer. pnpm copies the first at install and links
 * the second, and records only their path, so an edit in one moved no key
 * (Growth, file-dir-dep-stale.sh): the claim hashes its content. A
 * `file:` to an importer (an injected workspace package) is an edge
 * (`importerLinks`), and its directory is not content: its build output
 * re-keyed its dependants. Its copies are (`injectedCopies`).
 */
export function fileDeps(lock: Lockfile): string[] {
  const out = new Set(
    [...lock.directories.values()].filter((dir) => importerAt(lock, dir) === undefined),
  )
  const add = (dir: string, deps: ReadonlyMap<string, string>): void => {
    for (const version of deps.values()) {
      const target = linkTarget(lock, dir, version)
      if (target !== undefined && importerAt(lock, target) === undefined) out.add(target)
    }
  }
  for (const [dir, deps] of lock.importers) {
    add(dir, deps)
    for (const [name, version] of deps) {
      for (const copy of injectedCopies(lock, dir, name, version)) out.add(copy)
    }
  }
  // An override to a `link:` directory reaches a package's own
  // dependencies, written root-relative in its snapshot: one no importer
  // names was never read, so an edit in it moved no key.
  for (const deps of lock.snapshots.values()) add('.', deps)
  return [...out].sort()
}

const MANIFESTS = ['package.json', 'package.json5', 'package.yaml']

/**
 * With `excludeLinksFromLockfile`, each importer's manifest and the
 * directories its `link:` dependencies name that no importer holds: the
 * file records neither, so a linked directory's edit moved no key. The
 * manifests are named too, so a link added under an unchanged file reads
 * them anew rather than the directories the last read named. A manifest
 * that does not parse names nothing here: `discover` refuses it.
 */
export function manifestLinks(lock: Lockfile, root: string): string[] {
  if (!lock.excludesLinks) return []
  const out = new Set<string>()
  for (const importer of lock.importers.keys()) {
    for (const base of MANIFESTS) {
      const rel = joinPosix(importer, base)!
      let pkg: unknown
      try {
        const text = readFileSync(path.join(root, rel), 'utf8')
        out.add(rel)
        pkg = base.endsWith('.yaml')
          ? Bun.YAML.parse(text)
          : base.endsWith('.json5')
            ? Bun.JSON5.parse(text)
            : JSON.parse(text)
      } catch {
        continue
      }
      for (const field of DEP_FIELDS) {
        for (const spec of Object.values(record(record(pkg)?.[field]) ?? {})) {
          if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
          const to = spec.slice('link:'.length)
          const target = path.isAbsolute(to)
            ? path.relative(root, to).split(path.sep).join('/') || '.'
            : resolvePosix(importer, to)
          if (importerAt(lock, target) === undefined) out.add(target)
        }
      }
    }
  }
  return [...out].sort()
}

/**
 * Where importer `dir` finds an injected workspace package's copy, the
 * directory it reads: its own `node_modules` (the isolated linker links
 * it from `node_modules/.pnpm`), then the root's (the hoisted linker).
 * pnpm re-syncs the copy at install, not after a build vx runs, so keyed
 * as an edge alone a dependant read the old copy and saved its output
 * under the key of the package's new inputs, which hit once an install
 * re-synced it. Empty for any other dependency.
 */
function injectedCopies(lock: Lockfile, dir: string, name: string, version: string): string[] {
  if (!version.startsWith('file:')) return []
  const at = fileTarget(lock, version)
  const target = at === undefined ? undefined : importerAt(lock, at)
  if (target === undefined || target === dir) return []
  const own = joinPosix(dir, `node_modules/${name}`)!
  const root = `node_modules/${name}`
  return own === root ? [own] : [own, root]
}

function linkTarget(lock: Lockfile, dir: string, version: string): string | undefined {
  return version.startsWith('link:') ? resolvePosix(dir, version.slice('link:'.length)) : undefined
}

/**
 * The importer a directory installs: its own, or the one whose
 * `publishDirectory` it is. Read as no importer, `link:../b/dist` was no
 * edge: a built before b and folded none of b's dependencies, which
 * b/dist resolves through packages/b.
 */
function importerAt(lock: Lockfile, target: string): string | undefined {
  return lock.importers.has(target) ? target : lock.published.get(target)
}

function buildGraph(lock: Lockfile, files: ReadonlyMap<string, string>): Graph {
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
    const patch = patchOf(lock, key)
    const dir = lock.directories.get(key) ?? lock.directories.get(packageKey(key))
    const content = dir === undefined ? '' : `\0file\0${files.get(dir) ?? ''}`
    node(key, `${key}\0${resolution}\0${patch}${content}`)
  }
  // Each importer folds its own dir: with one material for all, two
  // importers that link each other were told apart by their edges alone,
  // and swapping which reaches which version gave the same lines, so a
  // lockfile that moved both installs keyed neither (item 1073).
  for (const dir of lock.importers.keys()) {
    node(importerNode(dir), `${importerNode(dir)}\nsections\0${lock.sections.get(dir)}`)
  }
  const link = (from: number, by: string, dir: string, name: string, version: string): void => {
    if (version.startsWith('link:')) {
      const target = linkTarget(lock, dir, version)
      const importer = target === undefined ? undefined : importerAt(lock, target)
      if (importer !== undefined) edges[from]!.push(index.get(importerNode(importer))!)
      else {
        const content = target === undefined ? '' : `\0file\0${files.get(target) ?? ''}`
        material[from] += `\nlink\0${name}\0${version}${content}`
      }
      return
    }
    const key = snapshotKey(lock, name, version)
    // pnpm refuses a dependency with no entry ("Broken lockfile",
    // ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY); made a leaf, a file cut after
    // `snapshots:` keyed every project on versions alone.
    const i = index.get(key)
    if (i === undefined) throw new Error(`pnpm-lock.yaml: no entry for ${key}, which ${by} names`)
    edges[from]!.push(i)
  }
  // A node folds the names it asks for as well as where they land: by
  // its edges alone, two aliases swapping targets (`foo: npm:x`, `bar:
  // npm:y` → the reverse) reached the same packages and kept the key,
  // while `require('foo')` loads another package.
  const named = (from: number, deps: ReadonlyMap<string, string>): void => {
    material[from] += `\nnames\0${[...deps]
      .map(([n, v]) => `${n}\0${v}`)
      .sort()
      .join('\0')}`
  }
  for (const [dir, deps] of lock.importers) {
    const from = index.get(importerNode(dir))!
    named(from, deps)
    for (const [name, version] of deps) {
      link(from, `importer ${dir}`, dir, name, version)
      for (const copy of injectedCopies(lock, dir, name, version)) {
        material[from] += `\ninjected\0${copy}\0${files.get(copy) ?? ''}`
      }
    }
  }
  for (const [key, deps] of lock.snapshots) {
    const from = index.get(key)!
    named(from, deps)
    for (const [name, version] of deps) link(from, key, '.', name, version)
  }
  return { index, material, edges }
}

/**
 * The root-relative directory a `file:` version installs from: v9 and v6
 * append resolved peers as `(peer@1)`, v5 as `_peer@1`.
 */
function fileTarget(lock: Lockfile, version: string): string | undefined {
  let rel = version.slice('file:'.length)
  const paren = rel.indexOf('(')
  if (paren !== -1) rel = rel.slice(0, paren)
  else if (Number.parseInt(lock.version, 10) < 6) {
    const underscore = rel.indexOf('_', rel.lastIndexOf('/') + 1)
    if (underscore !== -1 && rel.includes('@', underscore)) rel = rel.slice(0, underscore)
  }
  return joinPosix('.', rel)
}

/**
 * Each importer's `link:` dependencies on other importers, and its
 * `file:` ones that install an importer's directory: an injected
 * workspace package (`dependenciesMeta.<name>.injected`, or pnpm 10
 * `injectWorkspacePackages` with `dedupeInjectedDeps: false`), so
 * `^build` waits for its build. The dependant reads pnpm's copy, which
 * pnpm re-syncs at install, not after a build vx runs: the digest keys
 * the copy's content (`injectedCopies`). pnpm records
 * an auto-installed peer (`autoInstallPeers`, the default) under
 * `dependencies` like any other, so `peers` is empty here: the plugin
 * asks the importer's manifest which of these are peers. An importer a
 * snapshot it reaches links (an override to `workspace:`) is `transitive`.
 */
export function importerLinks(lock: Lockfile): ReadonlyMap<string, LockfileImporter> {
  const out = new Map<string, LockfileImporter>()
  const g = built.get(lock) ?? buildGraph(lock, new Map())
  const reached = reachedImporters(
    g.edges,
    new Map([...lock.importers.keys()].map((dir) => [g.index.get(importerNode(dir))!, dir])),
  )
  for (const [dir, deps] of lock.importers) {
    const links: Record<string, string> = {}
    for (const [name, version] of deps) {
      const at = version.startsWith('link:')
        ? joinPosix(dir, version.slice('link:'.length))
        : version.startsWith('file:')
          ? fileTarget(lock, version)
          : undefined
      const target = at === undefined ? undefined : importerAt(lock, at)
      if (target !== undefined && target !== dir) links[name] = target
    }
    out.set(dir, withTransitive({ deps: links, peers: {} }, reached.get(dir)))
  }
  return out
}
