// pnpm's v13 lockfile (`lockfile.format: v13`, pnpm 12.20+) read into the
// v9 shape `parseLockfile` keys. v13 is one JSON-like document: `projects`
// for `importers`, one `packages` entry per `name@version` for v9's
// `packages` + `snapshots`, and no peer suffix anywhere: a package lists
// its peers, and pnpm resolves each from the dependant's scope as it
// installs. So the v9 instances (`foo@1(react@18)`) are rebuilt here the
// same way, and `foo@1` reached under react 18 and under react 19 stays
// two nodes: read as one, b's react bump moved a's key too, and a's key
// never told the two installs apart.

import path from 'node:path'
import { type Json, record } from './json.js'

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** What v9 keeps at the top level and v13 moves into `settings`; `parseLockfile` reads them per importer. */
const MOVED = ['overrides', 'catalogs', 'patchedDependencies'] as const

interface Pkg {
  /** dependency name → version, alias (`x@1`), `file:` or `link:` */
  readonly deps: ReadonlyMap<string, string>
  /** peer name → the version every variant shares, or '' where it varies */
  readonly peers: ReadonlyMap<string, string>
  /** peers a dependency asks for (`below`): in the suffix, not installed beside it */
  readonly below: ReadonlySet<string>
}

/** A dependant's dependencies, each resolved once; peers look up the chain. */
interface Scope {
  readonly parent: Scope | undefined
  readonly deps: ReadonlyMap<string, string>
  readonly full: Map<string, string>
}

export function fromV13(doc: Json): Json {
  const settings = { ...record(doc['settings']) }
  const moved: Json = {}
  for (const k of MOVED) {
    if (settings[k] !== undefined) moved[k] = settings[k]
    delete settings[k]
  }
  const catalogs = record(moved['catalogs']) ?? {}
  const projects = record(doc['projects']) ?? {}
  const named = new Map<string, string>()
  for (const [dir, p] of Object.entries(projects)) {
    const name = record(p)?.['name']
    if (typeof name === 'string') named.set(name, dir)
  }

  const packages = new Map<string, Pkg>()
  const v9Packages: Json = {}
  for (const [key, raw] of Object.entries(record(doc['packages']) ?? {})) {
    const e = record(raw) ?? {}
    const deps = new Map<string, string>()
    for (const field of DEP_FIELDS) {
      for (const [n, v] of Object.entries(record(e[field]) ?? {})) deps.set(n, bare(String(v)))
    }
    const peers = new Map<string, string>()
    const below = new Set<string>()
    for (const [n, v] of Object.entries(record(e['peerDependencies']) ?? {})) {
      const fixed = record(v)?.['version']
      peers.set(n, typeof fixed === 'string' ? fixed : '')
      if (record(v)?.['below'] === true) below.add(n)
    }
    packages.set(key, { deps, peers, below })
    const resolution = resolutionOf(key, e)
    v9Packages[key] = resolution === undefined ? {} : { resolution }
  }

  const needs = peerNeeds(packages)
  const patches = record(moved['patchedDependencies']) ?? {}
  const snapshots: Json = {}
  const built = new Map<string, string>()

  const fullOf = (scope: Scope, name: string): string => {
    const known = scope.full.get(name)
    if (known !== undefined) return known
    const v = scope.deps.get(name)!
    const key = pkgKey(name, v)
    // A dependency cycle through a peer: the version alone, as pnpm stops there.
    scope.full.set(name, v)
    const full = key === undefined || !packages.has(key) ? v : `${v}${instance(key, scope)}`
    scope.full.set(name, full)
    return full
  }
  const lookup = (scope: Scope | undefined, name: string): string | undefined => {
    for (let s = scope; s !== undefined; s = s.parent) if (s.deps.has(name)) return fullOf(s, name)
    return undefined
  }
  /** The peer suffix `key` takes under `scope`, its snapshot written once per suffix. */
  const instance = (key: string, scope: Scope): string => {
    const pkg = packages.get(key)!
    const resolved = new Map<string, string>()
    for (const n of needs.get(key)!) {
      const fixed = pkg.peers.get(n)
      const seen = lookup(scope, n)
      // A version every variant shares binds the peer whatever the scope
      // holds; where the scope has none, pnpm installed it beside the package.
      const r = !fixed
        ? seen
        : seen !== undefined && base(seen) === fixed
          ? seen
          : fullOf({ parent: scope, deps: new Map([[n, fixed]]), full: new Map() }, n)
      if (r !== undefined) resolved.set(n, r)
    }
    // The patch first, then the peers sorted as pnpm sorts them, by the whole `name@version`.
    const patch = patchOf(patches, key)
    const suffix = `${patch === undefined ? '' : `(patch_hash=${patch})`}${[...resolved]
      .map(([n, r]) => `${n}@${r}`)
      .sort()
      .map((p) => `(${p})`)
      .join('')}`
    const id = `${key}${suffix}`
    if (built.has(id)) return suffix
    built.set(id, suffix)
    // The package itself is in its own scope: a dependency that peers on
    // its dependant (eslint → eslint-utils → peer eslint) resolves to it.
    const self = new Map(resolved)
    const name = nameOf(key)
    if (!self.has(name)) self.set(name, `${key.slice(name.length + 1)}${suffix}`)
    const own: Scope = {
      parent: { parent: undefined, deps: self, full: new Map(self) },
      deps: pkg.deps,
      full: new Map(),
    }
    const deps: Json = {}
    for (const n of pkg.deps.keys()) deps[n] = fullOf(own, n)
    for (const n of pkg.peers.keys()) {
      const r = resolved.get(n)
      if (r !== undefined && deps[n] === undefined && !pkg.below.has(n)) deps[n] = r
    }
    snapshots[id] = { dependencies: deps }
    return suffix
  }

  const importers: Json = {}
  for (const [dir, raw] of Object.entries(projects)) {
    const p = record(raw) ?? {}
    const entry: Json = {}
    for (const [k, v] of Object.entries(p)) if (k !== 'name') entry[k] = v
    const deps = new Map<string, string>()
    for (const field of DEP_FIELDS) {
      for (const [n, spec] of Object.entries(record(p[field]) ?? {})) {
        deps.set(n, implied(dir, n, spec, catalogs, named))
      }
    }
    const scope: Scope = { parent: undefined, deps, full: new Map() }
    for (const field of DEP_FIELDS) {
      const section = record(p[field])
      if (section === undefined) continue
      const out: Json = {}
      for (const n of Object.keys(section)) out[n] = { version: fullOf(scope, n) }
      entry[field] = out
    }
    importers[dir] = entry
  }

  const rest: Json = {}
  for (const [k, v] of Object.entries(doc)) if (k !== 'projects' && k !== 'packages') rest[k] = v
  return { ...rest, settings, ...moved, importers, packages: v9Packages, snapshots }
}

/**
 * Each package's peer names, its own and those a dependency leaves
 * unresolved: a dependency's peer its dependant does not install itself
 * resolves from the dependant's own scope, so it is the dependant's too.
 */
function peerNeeds(packages: ReadonlyMap<string, Pkg>): Map<string, ReadonlySet<string>> {
  const needs = new Map<string, Set<string>>()
  const parents = new Map<string, string[]>()
  for (const [key, pkg] of packages) {
    needs.set(key, new Set(pkg.peers.keys()))
    for (const [n, v] of pkg.deps) {
      const child = pkgKey(n, v)
      if (child === undefined || !packages.has(child)) continue
      const list = parents.get(child)
      if (list === undefined) parents.set(child, [key])
      else list.push(key)
    }
  }
  const work = [...packages.keys()].filter((k) => needs.get(k)!.size > 0)
  while (work.length > 0) {
    const child = work.pop()!
    for (const parent of parents.get(child) ?? []) {
      const own = packages.get(parent)!
      const self = nameOf(parent)
      const set = needs.get(parent)!
      const before = set.size
      for (const n of needs.get(child)!) if (!own.deps.has(n) && n !== self) set.add(n)
      if (set.size !== before) work.push(parent)
    }
  }
  return needs
}

/** The `packages` key a dependency resolves to; undefined for `link:`. */
function pkgKey(name: string, version: string): string | undefined {
  if (version.startsWith('link:')) return undefined
  return /^(@[^/@]+\/)?[^@/:]+@/.test(version) ? version : `${name}@${version}`
}

/** The patch hash pnpm applies to `name@version`: exact, then a range (`name@<=7`), then `name`. */
function patchOf(patches: Json, key: string): string | undefined {
  const name = nameOf(key)
  const version = key.slice(name.length + 1)
  let hit = patches[key]
  if (hit === undefined) {
    for (const [k, v] of Object.entries(patches)) {
      if (k.startsWith(`${name}@`) && Bun.semver.satisfies(version, k.slice(name.length + 1))) {
        hit = v
        break
      }
    }
  }
  hit ??= patches[name]
  return typeof hit === 'string' ? hit : undefined
}

/** `@s/foo@1.0.0` → `@s/foo` */
function nameOf(key: string): string {
  return key.slice(0, key.indexOf('@', 1))
}

/** `npm:x@1` (an alias) → `x@1`, as v9 writes it. */
function bare(version: string): string {
  return version.startsWith('npm:') ? version.slice('npm:'.length) : version
}

/** `18.3.1(react@18.3.1)` → `18.3.1` */
function base(version: string): string {
  const paren = version.indexOf('(')
  return paren === -1 ? version : version.slice(0, paren)
}

/**
 * A project's dependency as v9 records it. A bare string is the specifier,
 * its version implied: an exact version, `npm:` alias, `catalog:` entry,
 * `workspace:` project (by name) or `link:` path; an object says both.
 */
function implied(
  dir: string,
  name: string,
  spec: unknown,
  catalogs: Json,
  named: ReadonlyMap<string, string>,
): string {
  const object = record(spec)
  if (object !== undefined) {
    const version = object['version']
    return typeof version === 'string' ? bare(version) : ''
  }
  const s = String(spec)
  if (s.startsWith('catalog:')) {
    const catalog = record(catalogs[s.slice('catalog:'.length) || 'default'])
    // `{ specifier, version }`, or the version alone where they are one.
    const entry = catalog?.[name]
    const version = typeof entry === 'string' ? entry : record(entry)?.['version']
    if (typeof version !== 'string') return s
    // `{ specifier: 'npm:is-odd@^3.0.1', version: '3.0.1' }`: v9 names the package, `is-odd@3.0.1`.
    const specifier = record(entry)?.['specifier']
    if (
      typeof specifier === 'string' &&
      specifier.startsWith('npm:') &&
      !version.startsWith('npm:')
    ) {
      const target = bare(specifier)
      const at = target.lastIndexOf('@')
      return `${at > 0 ? target.slice(0, at) : target}@${version}`
    }
    return bare(version)
  }
  if (s.startsWith('workspace:')) {
    const alias = /^(@?[^@]+)@/.exec(s.slice('workspace:'.length))
    const target = named.get(alias?.[1] ?? name)
    return target === undefined ? s : `link:${path.posix.relative(dir, target) || '.'}`
  }
  return bare(s)
}

/** v9's `resolution`: the integrity beside any tarball / git / directory fields. */
function resolutionOf(key: string, e: Json): Json | undefined {
  const r = record(e['resolution'])
  const integrity = e['integrity']
  if (typeof integrity === 'string') return { integrity, ...r }
  if (r !== undefined) return r
  // A `file:` directory: v13 records no resolution, v9 recorded the directory.
  const at = key.indexOf('@file:', 1)
  return at === -1 ? undefined : { directory: key.slice(at + '@file:'.length), type: 'directory' }
}
