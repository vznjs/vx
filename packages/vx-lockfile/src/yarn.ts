// yarn.lock → one digest per workspace over the packages it can reach.
// Two generations, one graph. Berry (yarn 2+) is YAML: each entry is keyed
// by the descriptors it satisfies (`"foo@npm:^1.0.0, foo@npm:^1.2.0":`),
// carries `resolution`, `dependencies` / `peerDependencies` (name →
// range) and `checksum`; a workspace is `"a@workspace:packages/a"`. A
// dependency `bar: "npm:^2"` resolves to the entry keyed `bar@npm:^2`.
// Classic (yarn 1) is its own text format: `"foo@^1.0.0", "foo@^1.2.0":`
// then indented `version`, `resolved`, `integrity` and `dependencies:`
// with `bar "^2"` lines; classic has no workspace entries: Yarn 1 links a
// dependency on a workspace's name and keys no entry for it, so its links
// come from the workspaces' own `package.json` (`classicLinks`), and its
// one digest is the root's reach through every entry the file resolves.

import { reachDigests, type LockfileImporter } from '@vzn/vx'
import { depsOf, record, stable } from './json.js'
import { joinPosix } from './posix.js'
import { parseSyml } from './syml.js'

export interface Lockfile {
  readonly generation: 'berry' | 'classic'
  /** entry id (the resolution, or the first descriptor) → entry */
  readonly entries: ReadonlyMap<string, Entry>
  /** descriptor (`name@range`) → entry id */
  readonly descriptors: ReadonlyMap<string, string>
  /** workspace dir → entry id (berry only) */
  readonly workspaces: ReadonlyMap<string, string>
  /** package name → every entry a descriptor of that name resolves to (berry only) */
  readonly names: ReadonlyMap<string, readonly string[]>
  /**
   * `name@npm:range` → the entries of every `patch:` over it (berry only):
   * Yarn's builtin compat patches (`resolve`, `typescript`, `fsevents`,
   * item 1074) and a root `resolutions` patch (`yarn patch-commit -s`).
   * The workspace keeps asking for the plain descriptor, which keys the
   * unpatched entry, while a patched one is what Yarn installs. A
   * workspace asking for the plain descriptor beside one that names the
   * patch itself reaches it too: a patch edit re-keys it once too often,
   * never too seldom.
   */
  readonly patches: ReadonlyMap<string, readonly string[]>
  readonly global: string
}

export interface Entry {
  /** The package's own name, from the resolution (berry; '' for classic) */
  readonly name: string
  readonly version: string
  readonly deps: ReadonlyMap<string, string>
  /** `dependencies` alone, which a workspace entry merges its devDependencies into (berry only) */
  readonly installed: ReadonlyMap<string, string>
  /** resolution + checksum / version + resolved + integrity */
  readonly resolution: string
}

export function parseLockfile(text: string): Lockfile {
  const head = text.slice(0, 400)
  if (/^# yarn lockfile v1/m.test(head)) return parseClassic(text)
  if (/^__metadata:/m.test(head) || /^\s*version: \d/m.test(head)) return parseBerry(text)
  throw new Error(
    'yarn.lock: neither a classic (`# yarn lockfile v1`) nor a berry (`__metadata`) lockfile',
  )
}

function parseBerry(text: string): Lockfile {
  let doc: unknown = parseSyml(text)
  try {
    doc ??= Bun.YAML.parse(text)
  } catch (err) {
    throw new Error(`yarn.lock: ${err instanceof Error ? err.message : String(err)}`)
  }
  const d = record(doc)
  if (d === undefined) throw new Error('yarn.lock: not a YAML document')
  const entries = new Map<string, Entry>()
  const descriptors = new Map<string, string>()
  const workspaces = new Map<string, string>()
  const names = new Map<string, string[]>()
  const patches = new Map<string, string[]>()
  for (const [keys, raw] of Object.entries(d)) {
    if (keys === '__metadata') continue
    const e = record(raw) ?? {}
    const resolution = typeof e['resolution'] === 'string' ? e['resolution'] : keys
    // Every field of the entry but the dependencies it links, so a field
    // this parser has not heard of moves what reaches the entry: reading
    // the resolution and checksum alone dropped the root workspace's
    // `dependenciesMeta` (`built`, `unplugged`), which governs the whole
    // install (item 933).
    const material = Object.fromEntries(
      Object.entries(e).filter(([k]) => k !== 'dependencies' && k !== 'peerDependencies'),
    )
    entries.set(resolution, {
      name: resolution.slice(0, resolution.indexOf('@', 1)),
      version: typeof e['version'] === 'string' ? e['version'] : '',
      deps: depsOf(e, ['dependencies', 'peerDependencies']),
      installed: depsOf(e, ['dependencies']),
      resolution: `${resolution}\0${stable(material)}`,
    })
    // Yarn joins a key's descriptors with ', '; a range's own trailing
    // space is kept (forge's `p-limit: "npm:^3.1.0 "`), or its lookup
    // missed and fell back to every entry of the name.
    for (const k of keys.split(',')) {
      const descriptor = k.trimStart()
      descriptors.set(descriptor, resolution)
      const patch = /@patch:(.+?)#/.exec(descriptor)
      if (patch !== null) {
        let inner: string
        try {
          inner = decodeURIComponent(patch[1]!)
        } catch {
          inner = patch[1]!
        }
        inner = npmDefault(inner)
        const ids = patches.get(inner)
        if (ids === undefined) patches.set(inner, [resolution])
        else if (!ids.includes(resolution)) ids.push(resolution)
      }
      const name = descriptor.slice(0, descriptor.indexOf('@', 1))
      const ids = names.get(name)
      if (ids === undefined) names.set(name, [resolution])
      else if (!ids.includes(resolution)) ids.push(resolution)
    }
    const ws = resolution.indexOf('@workspace:')
    if (ws !== -1) workspaces.set(resolution.slice(ws + '@workspace:'.length), resolution)
  }
  const meta = record(d['__metadata']) ?? {}
  return {
    generation: 'berry',
    entries,
    descriptors,
    workspaces,
    names,
    patches,
    global: JSON.stringify({ version: meta['version'], cacheKey: meta['cacheKey'] }),
  }
}

// Yarn 2/3 write a patch's inner descriptor with no protocol
// (`resolve@^1.22.0`) where Yarn 4 writes `resolve@npm:^1.22.0`; npm: is
// Yarn's default, so both key the same plain descriptor (turborepo#4770).
function npmDefault(descriptor: string): string {
  const at = descriptor.indexOf('@', 1)
  const range = descriptor.slice(at + 1)
  return range.includes(':') ? descriptor : `${descriptor.slice(0, at)}@npm:${range}`
}

/** The classic format: an unquoted-YAML dialect with `key value` lines. */
function parseClassic(text: string): Lockfile {
  const entries = new Map<string, Entry>()
  const descriptors = new Map<string, string>()
  let keys: string[] | null = null
  let fields: Record<string, string> = {}
  let deps = new Map<string, string>()
  let inDeps = false
  const flush = (): void => {
    if (keys === null) return
    const id = keys[0]!
    // The descriptors an entry satisfies are part of what the file records:
    // `foo@^1.0.0` moving from the 1.0.0 entry to the 1.1.0 one (a
    // deduplication, `yarn upgrade`) changes what a workspace installs
    // while every entry's version, url and integrity stay as they were, and
    // the digest did not move (item 902). Classic has no workspace entries
    // to carry that edge, so each entry carries its own descriptors.
    entries.set(id, {
      name: '',
      version: fields['version'] ?? '',
      deps,
      installed: deps,
      resolution: `${fields['version'] ?? ''}\0${fields['resolved'] ?? ''}\0${fields['integrity'] ?? ''}\0${[...keys].sort().join(',')}`,
    })
    for (const k of keys) descriptors.set(k, id)
    keys = null
    fields = {}
    deps = new Map()
    inDeps = false
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length === 0 || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      flush()
      keys = line
        .replace(/:$/, '')
        .split(',')
        .map((k) => unquote(k.trim()))
      continue
    }
    if (keys === null) continue
    const depth = line.length - line.trimStart().length
    const body = line.trim()
    if (depth === 2) {
      inDeps = false
      if (body === 'dependencies:' || body === 'optionalDependencies:') {
        inDeps = true
        continue
      }
      const sp = body.indexOf(' ')
      if (sp !== -1) fields[body.slice(0, sp)] = unquote(body.slice(sp + 1).trim())
      continue
    }
    if (depth >= 4 && inDeps) {
      const sp = body.indexOf(' ')
      if (sp !== -1) deps.set(unquote(body.slice(0, sp)), unquote(body.slice(sp + 1).trim()))
    }
  }
  flush()
  return {
    generation: 'classic',
    entries,
    descriptors,
    workspaces: new Map(),
    names: new Map(),
    patches: new Map(),
    global: 'classic',
  }
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

/**
 * Classic's links: Yarn 1 records no workspace, so they come from each
 * workspace's manifest (`manifests`: importer dir → `package.json`, `.`
 * the root). A dependency on a workspace's name is linked unless the file
 * keys its descriptor, which Yarn writes only for the registry copy it
 * fetched when the workspace's version misses the range, and a `file:`
 * range is a copy, no link. A peer on a
 * workspace with no installed entry of that name is a peer link.
 */
export function classicLinks(
  lock: Lockfile,
  manifests: ReadonlyMap<string, Record<string, unknown>>,
): ReadonlyMap<string, LockfileImporter> {
  const count = new Map<string, number>()
  const dirOf = new Map<string, string>()
  for (const [dir, pkg] of manifests) {
    const n = pkg['name']
    if (typeof n !== 'string' || n === '') continue
    count.set(n, (count.get(n) ?? 0) + 1)
    dirOf.set(n, dir)
  }
  const workspace = (name: string): string | undefined =>
    count.get(name) === 1 ? dirOf.get(name) : undefined
  const forced = everywhereResolutions(manifests.get('.'))
  const out = new Map<string, LockfileImporter>()
  for (const [dir, pkg] of manifests) {
    const links = { deps: {} as Record<string, string>, peers: {} as Record<string, string> }
    const installed = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of depsOf(pkg, [field])) {
        installed.add(name)
        const target = workspace(name)
        // A root resolution rewrites the request before the workspace is
        // asked: Yarn keys the resolution's range, never the manifest's.
        const asked = forced.get(name) ?? range
        // A `file:` range is a copy packed at install, as berry's (`linkedDir`).
        if (asked.startsWith('file:')) continue
        if (target !== undefined && target !== dir && !lock.descriptors.has(`${name}@${asked}`)) {
          links.deps[name] = target
        }
      }
    }
    for (const name of depsOf(pkg, ['peerDependencies']).keys()) {
      const target = workspace(name)
      if (target !== undefined && target !== dir && !installed.has(name)) links.peers[name] = target
    }
    out.set(dir, links)
  }
  return out
}

/**
 * The root manifest's Yarn 1 `resolutions` that rewrite every request of a
 * name (`ms`, `**\/ms`, `@s/x`), name → range, the first that names it
 * winning as in Yarn. One scoped to a parent (`a/ms`, `a/**\/ms`) is left
 * out: Yarn 1.22 keys its range and still hoists the workspace link over
 * it, so the link stands.
 */
function everywhereResolutions(root: Record<string, unknown> | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const [pattern, range] of depsOf(root ?? {}, ['resolutions'])) {
    const name = pattern.replace(/^(?:\*\*\/)+/, '')
    if (!/^(?:@[^/]+\/)?[^/@*]+$/.test(name) || out.has(name)) continue
    out.set(name, range)
  }
  return out
}

/**
 * `bar` + `npm:^2` → the entry keyed `bar@npm:^2`; classic: `bar@^2`. A
 * bare range gets berry's `npm:` prefix. A `workspace:` range resolves to
 * the workspace entry of that name whatever the range says (`*`, `^`, a
 * path) — berry lists the range among the keys, but the name is enough.
 *
 * A Yarn 4 catalog range (`catalog:`, `catalog:<name>`) is recorded as
 * that literal, and the range the catalog names lives in `.yarnrc.yml`,
 * not here: the entry it resolved to is in the file, but nothing points
 * at it. So it resolves to EVERY entry of that package — a bump of any
 * of them moves the workspace, never a bump of none (turborepo#12635).
 * Which one the catalog names is `.yarnrc.yml`'s to say, and core folds
 * that file into every key.
 */
function resolveDescriptor(
  lock: Lockfile,
  from: string,
  name: string,
  range: string,
): readonly string[] {
  // A patched descriptor reaches the patched entries Yarn installs as well
  // as the plain one it keys (item 1074).
  const withPatch = (descriptor: string, id: string): readonly string[] => {
    const patched = lock.patches.get(npmDefault(descriptor))
    return patched === undefined ? [id] : [id, ...patched.filter((p) => p !== id)]
  }
  const direct = lock.descriptors.get(`${name}@${range}`)
  if (direct !== undefined) return withPatch(`${name}@${range}`, direct)
  if (lock.generation !== 'berry') return []
  // A path range (`portal:`, `file:`, `link:`) is keyed bound to the
  // package that names it, `::locator=<its locator>`; unbound it fell
  // back to every entry of the name, another workspace's included.
  const bound = lock.descriptors.get(`${name}@${range}::locator=${encodeURIComponent(from)}`)
  if (bound !== undefined) return [bound]
  if (range.startsWith('workspace:')) {
    for (const id of lock.workspaces.values()) if (id.startsWith(`${name}@workspace:`)) return [id]
    return []
  }
  if (range.startsWith('catalog:')) return lock.names.get(name) ?? []
  if (!range.includes(':')) {
    const bare = lock.descriptors.get(`${name}@npm:${range}`)
    if (bare !== undefined) return withPatch(`${name}@npm:${range}`, bare)
  }
  // A descriptor the file does not key: a root `resolutions` override
  // rewrote it (to a `patch:`, another range), so what is installed is an
  // entry nothing in the file points at. Edges to nowhere left that entry
  // outside every workspace's reach, and a patch edit re-keyed nothing
  // (item 903). Every entry of the name, as for a catalog: a bump of any
  // of them moves the workspace, never a bump of none.
  return lock.names.get(name) ?? []
}

/**
 * Each berry workspace's dependencies whose descriptor the file resolves
 * to a workspace entry (a `workspace:` range, or a range Yarn's
 * transparent workspaces satisfied with one), and its peers on a
 * workspace of that name, which Yarn hoists whatever the range. Only a
 * descriptor the file keys counts: the name fallbacks the digest takes
 * (a catalog, an override) name no link. Classic records no workspaces,
 * so it has none here (`classicLinks`).
 */
export function importerLinks(lock: Lockfile): ReadonlyMap<string, LockfileImporter> {
  const out = new Map<string, LockfileImporter>()
  const dirOf = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const [dir, id] of lock.workspaces) {
    dirOf.set(id, dir)
    byName.set(id.slice(0, id.indexOf('@workspace:')), dir)
  }
  for (const [dir, id] of lock.workspaces) {
    const entry = lock.entries.get(id)!
    const links = { deps: {} as Record<string, string>, peers: {} as Record<string, string> }
    const add = (kind: 'deps' | 'peers', name: string, target: string | undefined): void => {
      if (target !== undefined && target !== dir) links[kind][name] = target
    }
    for (const [name, range] of entry.installed) {
      const keyed = keyedDescriptor(lock, id, name, range)
      add(
        'deps',
        name,
        keyed === undefined
          ? range.startsWith('workspace:')
            ? byName.get(name)
            : undefined
          : (dirOf.get(keyed) ?? linkedDir(lock, dirOf, keyed)),
      )
    }
    for (const name of entry.deps.keys()) {
      if (!entry.installed.has(name)) add('peers', name, byName.get(name))
    }
    out.set(dir, links)
  }
  return out
}

/**
 * The workspace a `link:` or `portal:` entry symlinks, from its resolution
 * (`b@link:../b::locator=a%40workspace%3Apackages%2Fa`): the path, from the
 * locating workspace's dir. A `file:` entry is a copy packed at install,
 * no link to the workspace's build.
 */
function linkedDir(
  lock: Lockfile,
  dirOf: ReadonlyMap<string, string>,
  id: string,
): string | undefined {
  const target = linkPath(dirOf, id)
  return target !== undefined && lock.workspaces.has(target) ? target : undefined
}

/** The root-relative directory a berry `link:` or `portal:` entry symlinks. */
function linkPath(dirOf: ReadonlyMap<string, string>, id: string): string | undefined {
  const m = /^(?:@[^@/]+\/)?[^@]+@(?:link|portal):([^:]*)::locator=([^&]+)/.exec(id)
  if (m === null) return undefined
  let locator: string
  try {
    locator = decodeURIComponent(m[2]!)
  } catch {
    return undefined
  }
  const from = dirOf.get(locator)
  return from === undefined ? undefined : joinPosix(from, m[1]!)
}

/**
 * Each entry's directory whose content is what a task reads and the file
 * pins nowhere: berry's `link:` / `portal:` to a directory that is no
 * workspace (a symlink), and classic's `file:` (a copy, no hash) and
 * `link:` (a symlink). Berry's
 * `file:` carries its own `::hash=`.
 */
function contentDirs(lock: Lockfile): Map<string, string> {
  const out = new Map<string, string>()
  if (lock.generation === 'classic') {
    for (const id of lock.entries.keys()) {
      const m = /^.[^@]*@(?:file|link):(.+)$/.exec(id)
      if (m !== null) out.set(id, m[1]!)
    }
    return out
  }
  const dirOf = new Map<string, string>()
  for (const [dir, id] of lock.workspaces) dirOf.set(id, dir)
  for (const id of lock.entries.keys()) {
    const target = linkPath(dirOf, id)
    if (target !== undefined && target !== '.' && !lock.workspaces.has(target)) out.set(id, target)
  }
  return out
}

/**
 * The directories `contentDirs` names, for the claim to hash, but a
 * classic `link:` to a directory `workspace` says is one: Yarn 1 links
 * that workspace as it would by its name. Berry's also `.yarnrc.yml`,
 * whose `packageExtensions` the digest reads: as an extra file it joins
 * the memo's identity, so an extension edit under an unchanged lockfile
 * digests anew rather than replaying the old closure.
 */
export function fileDeps(lock: Lockfile, workspace?: (dir: string) => boolean): string[] {
  const out = new Set<string>()
  for (const [id, dir] of contentDirs(lock)) {
    if (workspace !== undefined && /^.[^@]*@link:/.test(id) && workspace(dir)) continue
    out.add(dir)
  }
  const dirs = [...out].sort()
  return lock.generation === 'berry' ? [...dirs, YARNRC] : dirs
}

export const YARNRC = '.yarnrc.yml'

/** One `packageExtensions` selector (`ident@range`) and the dependencies it adds. */
export interface Extension {
  readonly name: string
  readonly range: string
  readonly deps: ReadonlyMap<string, string>
}

// Yarn's builtin list (yarnpkg-extensions) adds one dependency; the rest
// are peers, which the parent that provides them already reaches.
const BUILTIN: readonly Extension[] = [
  { name: '@babel/parser', range: '*', deps: new Map([['@babel/types', '^7.8.3']]) },
]

/**
 * Yarn's builtin extensions and `.yarnrc.yml`'s `packageExtensions`
 * dependencies. A file Yarn itself would refuse adds none: the entries
 * an extension installed are then reached by no one, and every workspace
 * folds them (`importerDigests`).
 */
export function packageExtensions(rc: string | undefined): readonly Extension[] {
  if (rc === undefined) return BUILTIN
  let doc: unknown
  try {
    doc = Bun.YAML.parse(rc)
  } catch {
    return BUILTIN
  }
  const out = [...BUILTIN]
  for (const [selector, raw] of Object.entries(record(record(doc)?.['packageExtensions']) ?? {})) {
    const deps = depsOf(record(raw) ?? {}, ['dependencies'])
    if (deps.size === 0) continue
    const at = selector.indexOf('@', 1)
    out.push(
      at === -1
        ? { name: selector, range: '*', deps }
        : { name: selector.slice(0, at), range: selector.slice(at + 1), deps },
    )
  }
  return out
}

/**
 * Whether `version` is what the selector's range extends. Yarn matches
 * prereleases too (`satisfiesWithPrereleases`), and a range this cannot
 * read matches: an edge too many re-keys once too often, never too seldom.
 */
function matches(range: string, version: string): boolean {
  const r = range.startsWith('npm:') ? range.slice(4) : range
  try {
    if (Bun.semver.satisfies(version, r)) return true
    const release = version.replace(/[-+].*$/, '')
    return release !== version && Bun.semver.satisfies(release, r)
  } catch {
    return true
  }
}

/** The entry a descriptor the file keys resolves to: as written, bound to `from`, or with berry's `npm:` prefix. */
function keyedDescriptor(
  lock: Lockfile,
  from: string,
  name: string,
  range: string,
): string | undefined {
  return (
    lock.descriptors.get(`${name}@${range}`) ??
    lock.descriptors.get(`${name}@${range}::locator=${encodeURIComponent(from)}`) ??
    (range.includes(':') ? undefined : lock.descriptors.get(`${name}@npm:${range}`))
  )
}

/**
 * Yarn installs a `packageExtensions` dependency for each package its
 * selector matches that does not declare one of that name, and records
 * it on no entry (turborepo#14873): only the added package is keyed, so
 * the extended package gets the edge here. Then every entry no workspace
 * reaches (one an extension vx could not read installed) becomes an edge
 * of every workspace: it is installed for one of them.
 */
function extend(
  lock: Lockfile,
  index: ReadonlyMap<string, number>,
  edges: number[][],
  extensions: readonly Extension[],
): void {
  for (const [id, e] of lock.entries) {
    for (const ext of extensions) {
      if (ext.name !== e.name || !matches(ext.range, e.version)) continue
      for (const [name, range] of ext.deps) {
        if (e.installed.has(name)) continue
        for (const target of resolveDescriptor(lock, id, name, range)) {
          edges[index.get(id)!]!.push(index.get(target)!)
        }
      }
    }
  }
  const roots = [...lock.workspaces.values()].map((id) => index.get(id)!)
  const seen = new Uint8Array(edges.length)
  const stack = [...roots]
  for (const r of roots) seen[r] = 1
  while (stack.length > 0) {
    for (const w of edges[stack.pop()!]!) {
      if (seen[w] === 0) {
        seen[w] = 1
        stack.push(w)
      }
    }
  }
  const orphans: number[] = []
  for (let i = 0; i < seen.length; i++) if (seen[i] === 0) orphans.push(i)
  if (orphans.length > 0) for (const r of roots) edges[r]!.push(...orphans)
}

/**
 * Every workspace's digest. Berry: one node per entry, workspaces among
 * them, keyed by dir. Classic: the file has no workspace entries, so the
 * one digest is the root's (`.`) over every entry the file resolves —
 * coarse, and honest about what classic records.
 */
export function importerDigests(
  lock: Lockfile,
  files: ReadonlyMap<string, string> = new Map(),
  extensions: readonly Extension[] = BUILTIN,
): ReadonlyMap<string, string> {
  const index = new Map<string, number>()
  const material: string[] = []
  const edges: number[][] = []
  const dirs = contentDirs(lock)
  for (const [id, e] of lock.entries) {
    index.set(id, material.length)
    const dir = dirs.get(id)
    material.push(
      dir === undefined ? e.resolution : `${e.resolution}\nfile\0${files.get(dir) ?? ''}`,
    )
    edges.push([])
  }
  for (const [id, e] of lock.entries) {
    const from = index.get(id)!
    for (const [name, range] of e.deps) {
      const targets = resolveDescriptor(lock, id, name, range)
      for (const target of targets) edges[from]!.push(index.get(target)!)
      if (targets.length === 0) material[from] += `\nunresolved\0${name}\0${range}`
    }
  }
  if (lock.generation === 'berry') {
    // A `link:` or `portal:` to a workspace symlinks the workspace itself:
    // its entry lists no dependencies, and as a leaf the linked
    // workspace's bumps moved no key of the project linking it.
    const dirOf = new Map<string, string>()
    for (const [dir, id] of lock.workspaces) dirOf.set(id, dir)
    for (const id of lock.entries.keys()) {
      const target = linkedDir(lock, dirOf, id)
      if (target !== undefined)
        edges[index.get(id)!]!.push(index.get(lock.workspaces.get(target)!)!)
    }
    extend(lock, index, edges, extensions)
  }
  const digests = reachDigests({ material, edges })
  // The global digest rides as DATA: Bun's xxHash3 reads only the low 32
  // bits of a seed, so two lockfiles' globals could share one (item 682).
  const global = Bun.hash.xxHash3(lock.global).toString(16).padStart(16, '0')
  const out = new Map<string, string>()
  const fold = (h: string) => Bun.hash.xxHash3(`${global}\0${h}`).toString(16).padStart(16, '0')
  if (lock.generation === 'classic') {
    const all = ['classic', global, ...[...digests].sort()].join('\n')
    out.set('.', Bun.hash.xxHash3(all).toString(16).padStart(16, '0'))
    return out
  }
  for (const [dir, id] of lock.workspaces) out.set(dir, fold(digests[index.get(id)!]!))
  return out
}
