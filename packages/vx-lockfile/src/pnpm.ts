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

import { reachDigests, type LockfileImporter } from '@vzn/vx'
import { record, stable } from './json.js'
import { joinPosix } from './posix.js'

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
  const rawImporters = record(doc['importers'])
  if (rawImporters !== undefined) {
    for (const [dir, entry] of Object.entries(rawImporters)) importers.set(dir, depsOf(entry))
  } else if (DEP_FIELDS.some((f) => doc[f] !== undefined)) {
    // A single-package lockfile keeps its dependencies at the top level.
    importers.set('.', depsOf(doc))
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
  return { version, importers, snapshots, resolutions, patches, directories, global, excludesLinks }
}

/**
 * Whether pnpm drops a manifest's dependency `name` from the install:
 * one of its `optionalDependencies` the lockfile's
 * `ignoredOptionalDependencies` names (pnpm also drops it from
 * `dependencies`, and records it nowhere), matched as `@pnpm/matcher`
 * does: `*` any run, a leading `!` excludes.
 */
export function ignoredOptional(
  text: string,
): (name: string, pkg: Record<string, unknown>) => boolean {
  const list = topLevel(text, 'ignoredOptionalDependencies')
  const patterns = Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
  if (patterns.length === 0) return () => false
  const matchers = patterns.map((p) => {
    const ignore = p.startsWith('!')
    const pattern = ignore ? p.slice(1) : p
    const re = new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`)
    return { ignore, match: (s: string) => re.test(s) }
  })
  const hasInclude = matchers.some((m) => !m.ignore)
  const hasIgnore = matchers.some((m) => m.ignore)
  const matches = (name: string): boolean => {
    if (!hasIgnore) return matchers.some((m) => m.match(name))
    if (!hasInclude) return !matchers.some((m) => m.match(name))
    let matched = false
    for (const m of matchers) {
      if (m.ignore) {
        if (m.match(name)) matched = false
      } else if (!matched && m.match(name)) matched = true
    }
    return matched
  }
  return (name, pkg) => {
    const optional = record(pkg['optionalDependencies'])
    return optional !== undefined && Object.hasOwn(optional, name) && matches(name)
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

/** `settings.excludeLinksFromLockfile`, read from its block alone as `recordedImporters` reads. */
export function excludesLinks(text: string): boolean {
  return record(topLevel(text, 'settings'))?.['excludeLinksFromLockfile'] === true
}

/**
 * The last document's top-level `key`, parsed from its block alone (to
 * the next top-level key); undefined where pnpm wrote no such block. A
 * CRLF file (a Windows checkout) heads it `key:\r\n`: found by `\n`
 * alone, the block read as absent though the whole parse has it.
 */
function topLevel(text: string, key: string): unknown {
  const doc = Math.max(text.lastIndexOf('\n---'), 0)
  // The first line's ending says which: a second scan cost every LF run.
  const head = text.charCodeAt(text.indexOf('\n') - 1) === 13 ? `\n${key}:\r\n` : `\n${key}:\n`
  const at = text.indexOf(head, doc)
  if (at < 0) return undefined
  const block = text.slice(at + 1)
  const end = /\n\S/.exec(block.slice(head.length - 1))
  return record(
    Bun.YAML.parse(end === null ? block : block.slice(0, head.length - 1 + end.index + 1)),
  )?.[key]
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
function snapshotKey(lock: Lockfile, name: string, version: string): string {
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
 * Every importer's digest: the lockfile as one graph (importers and
 * snapshots alike), each node's material its identity, and core's
 * `reachDigests` folding what every node reaches (components, so pnpm's
 * cycles terminate). A `link:` dependency is an edge to the linked
 * importer's node, so what project A can import through workspace
 * package B is B's whole reach.
 */
export function importerDigests(
  lock: Lockfile,
  files: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const g = buildGraph(lock, files)
  const hashes = reachDigests(g)
  const out = new Map<string, string>()
  // The global digest rides as DATA: Bun's xxHash3 reads only the low 32
  // bits of a seed, so two lockfiles' globals could share one (item 682).
  const global = Bun.hash.xxHash3(lock.global).toString(16).padStart(16, '0')
  const reachOf = (dir: string): string => hashes[g.index.get(importerNode(dir))!]!
  // With its links left out, the file does not say which importer links
  // which, so each folds them all: keyed by its own reach, a project
  // linking another missed a bump in the linked one's dependencies.
  const all = lock.excludesLinks
    ? [...lock.importers.keys()].sort().map(reachOf).join('\0')
    : undefined
  for (const dir of lock.importers.keys()) {
    const h = Bun.hash.xxHash3(`${global}\0${all ?? reachOf(dir)}`)
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

/**
 * The directories `file:` dependencies install from, and those a `link:`
 * names that is no importer. pnpm copies the first at install and links
 * the second, and records only their path, so an edit in one moved no key
 * (Growth, file-dir-dep-stale.sh): the claim hashes its content.
 */
export function fileDeps(lock: Lockfile): string[] {
  const out = new Set(lock.directories.values())
  const add = (dir: string, deps: ReadonlyMap<string, string>): void => {
    for (const version of deps.values()) {
      const target = linkTarget(lock, dir, version)
      if (target !== undefined && !lock.importers.has(target)) out.add(target)
    }
  }
  for (const [dir, deps] of lock.importers) add(dir, deps)
  // An override to a `link:` directory reaches a package's own
  // dependencies, written root-relative in its snapshot: one no importer
  // names was never read, so an edit in it moved no key.
  for (const deps of lock.snapshots.values()) add('.', deps)
  return [...out].sort()
}

function linkTarget(lock: Lockfile, dir: string, version: string): string | undefined {
  return version.startsWith('link:') ? joinPosix(dir, version.slice('link:'.length)) : undefined
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
    const patch =
      lock.patches.get(packageKey(key)) ?? lock.patches.get(packageName(lock, key)) ?? ''
    const dir = lock.directories.get(key) ?? lock.directories.get(packageKey(key))
    const content = dir === undefined ? '' : `\0file\0${files.get(dir) ?? ''}`
    node(key, `${key}\0${resolution}\0${patch}${content}`)
  }
  // Each importer folds its own dir: with one material for all, two
  // importers that link each other were told apart by their edges alone,
  // and swapping which reaches which version gave the same lines, so a
  // lockfile that moved both installs keyed neither (item 1073).
  for (const dir of lock.importers.keys()) node(importerNode(dir), importerNode(dir))
  const link = (from: number, dir: string, name: string, version: string): void => {
    if (version.startsWith('link:')) {
      const target = linkTarget(lock, dir, version)
      if (target !== undefined && lock.importers.has(target))
        edges[from]!.push(index.get(importerNode(target))!)
      else {
        const content = target === undefined ? '' : `\0file\0${files.get(target) ?? ''}`
        material[from] += `\nlink\0${name}\0${version}${content}`
      }
      return
    }
    const key = snapshotKey(lock, name, version)
    // A dependency with no snapshot (a leaf the file lists only by version)
    // is a node of its own, so its version still counts.
    edges[from]!.push(node(key, `${key}\0${lock.resolutions.get(packageKey(key)) ?? ''}\0`))
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
    for (const [name, version] of deps) link(from, dir, name, version)
  }
  for (const [key, deps] of lock.snapshots) {
    const from = index.get(key)!
    named(from, deps)
    for (const [name, version] of deps) link(from, '.', name, version)
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
 * `injectWorkspacePackages` with `dedupeInjectedDeps: false`). pnpm
 * hard-links that copy and re-syncs it after the package's own scripts,
 * so it is the workspace package and `^build` waits for it; yarn's
 * packed `file:` copy is not. pnpm records
 * an auto-installed peer (`autoInstallPeers`, the default) under
 * `dependencies` like any other, so `peers` is empty here: the plugin
 * asks the importer's manifest which of these are peers.
 */
export function importerLinks(lock: Lockfile): ReadonlyMap<string, LockfileImporter> {
  const out = new Map<string, LockfileImporter>()
  for (const [dir, deps] of lock.importers) {
    const links: Record<string, string> = {}
    for (const [name, version] of deps) {
      const target = version.startsWith('link:')
        ? joinPosix(dir, version.slice('link:'.length))
        : version.startsWith('file:')
          ? fileTarget(lock, version)
          : undefined
      if (target !== undefined && target !== dir && lock.importers.has(target)) {
        links[name] = target
      }
    }
    out.set(dir, { deps: links, peers: {} })
  }
  return out
}
