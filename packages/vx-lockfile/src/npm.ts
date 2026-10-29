// package-lock.json (lockfileVersion 2 and 3) → one digest per workspace
// package over the packages it can reach. `packages` is keyed by
// node_modules path: `""` is the root manifest, `node_modules/foo` a
// hoisted package, `node_modules/foo/node_modules/bar` one nested under
// it, `packages/a` a workspace package, and `node_modules/a` a link to it
// (`link: true, resolved: "packages/a"`). A dependency `d` of the package
// at path `p` is `p/node_modules/d` when that key exists, else the nearest
// ancestor directory's, else `node_modules/d` — Node's own walk.

import { reachDigests, type LockfileImporter } from '@vzn/vx'
import { depsOf, peerOnly, record } from './json.js'

export interface Lockfile {
  readonly version: number
  /** path → entry */
  readonly packages: ReadonlyMap<string, Entry>
  /** Material every workspace folds. */
  readonly global: string
  /** Directories `file:` dependencies link to or copy: not the root, not a workspace. */
  readonly fileDirs: readonly string[]
}

export interface Entry {
  readonly deps: ReadonlyMap<string, string>
  /** version + resolved + integrity — whatever pins the bytes; '' for a link, the root, a workspace */
  readonly resolution: string
  /** the path a `link: true` entry points at */
  readonly link: string | undefined
  /** the `file:` directory an entry is a copy of (`install-links=true`) */
  readonly copyOf: string | undefined
  readonly isWorkspace: boolean
  /** the peers it installs no entry for */
  readonly peers: ReadonlySet<string>
}

export function parseLockfile(text: string): Lockfile {
  // The claim names the file: npm-shrinkwrap.json or package-lock.json.
  const doc: unknown = JSON.parse(text)
  const d = record(doc)
  const version = d === undefined ? undefined : d['lockfileVersion']
  if (typeof version !== 'number') {
    throw new Error('not an npm lockfile (no lockfileVersion)')
  }
  if (version < 2) {
    throw new Error(
      `lockfileVersion ${version} has no \`packages\` map — npm 7+ writes version 2 or 3`,
    )
  }
  const raws = record(d!['packages']) ?? {}
  const isMember = workspaceMatcher(raws[''])
  const packages = new Map<string, Entry>()
  for (const [p, raw] of Object.entries(raws)) {
    const e = record(raw) ?? {}
    const link = e['link'] === true && typeof e['resolved'] === 'string' ? e['resolved'] : undefined
    // A tarball carries its integrity; a directory npm packed and copied
    // (`install-links=true`) carries none, only its path.
    const resolved = e['resolved']
    const copyOf =
      link === undefined &&
      typeof resolved === 'string' &&
      resolved.startsWith('file:') &&
      typeof e['integrity'] !== 'string'
        ? resolved.slice('file:'.length)
        : undefined
    const isWorkspace =
      p !== '' && !p.startsWith('node_modules/') && !p.includes('/node_modules/') && isMember(p)
    packages.set(p, {
      deps: depsOf(e),
      // The root's and a workspace's `version` is their own package.json's,
      // not what npm installed: a release bump of the root re-keyed every
      // task with node_modules unchanged.
      resolution:
        link === undefined && p !== '' && !isWorkspace
          ? [e['version'], e['resolved'], e['integrity']]
              .map((v) => (typeof v === 'string' ? v : ''))
              .join('\0')
          : '',
      link,
      copyOf,
      isWorkspace,
      peers: peerOnly(e),
    })
  }
  // Root `overrides` are not folded: what an override forced is the entry a
  // workspace reaches, and npm 10 does not write them here at all (D-142).
  const global = JSON.stringify({ lockfileVersion: version })
  const fileDirs = new Set<string>()
  for (const e of packages.values()) {
    if (e.link !== undefined && e.link !== '' && packages.get(e.link)?.isWorkspace !== true) {
      fileDirs.add(e.link)
    }
    if (e.copyOf !== undefined) fileDirs.add(e.copyOf)
  }
  return { version, packages, global, fileDirs: [...fileDirs].sort() }
}

/**
 * Whether a path is a member by the root's `workspaces` globs: what tells
 * a workspace from a `file:` directory, both entries outside node_modules
 * that a link resolves to. Taking every such entry for a workspace made
 * `vendor/dep` a project, so an edit under it selected nothing. A root
 * that names none has no workspace, and every such entry is a `file:`
 * directory (taken for workspaces, their content was never hashed). A
 * `!` glob excludes, as npm reads it: as a glob of its own it matched
 * every other path.
 */
function workspaceMatcher(root: unknown): (p: string) => boolean {
  const ws = record(root)?.['workspaces']
  const list = Array.isArray(ws) ? ws : record(ws)?.['packages']
  if (!Array.isArray(list)) return () => false
  const glob = (g: string) => new Bun.Glob(g.replace(/^\.\//, '').replace(/\/+$/, ''))
  const strings = list.filter((g): g is string => typeof g === 'string')
  const include = strings.filter((g) => !g.startsWith('!')).map(glob)
  const exclude = strings.filter((g) => g.startsWith('!')).map((g) => glob(g.slice(1)))
  return (p) => include.some((g) => g.match(p)) && !exclude.some((g) => g.match(p))
}

/**
 * Node's walk: `p/node_modules/name`, then the same under each ancestor
 * directory that is not itself a `node_modules`, then `node_modules/name`.
 * A workspace nested in another's directory (`packages/a/packages/n`)
 * resolves through `packages/a/node_modules`, where npm nests what only it
 * needs; stepping from one `/node_modules/` boundary to the next skipped
 * that directory, and `n` was keyed on its spec alone (D-139).
 */
function resolve(lock: Lockfile, from: string, name: string): string | undefined {
  let base = from
  for (;;) {
    if (base !== 'node_modules' && !base.endsWith('/node_modules')) {
      const key = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`
      if (lock.packages.has(key)) return key
    }
    if (base === '') return undefined
    const i = base.lastIndexOf('/')
    base = i === -1 ? '' : base.slice(0, i)
  }
}

/**
 * Every workspace package's digest (by dir, `.` for the root): the
 * lockfile as one graph — a node per path, its material the resolution,
 * an edge per resolved dependency, a link's edge to its target — folded
 * by core's `reachDigests`.
 */
export function importerDigests(
  lock: Lockfile,
  files: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const index = new Map<string, number>()
  const material: string[] = []
  const edges: number[][] = []
  for (const [p, e] of lock.packages) {
    index.set(p, material.length)
    // An installed package is its install name and what it is, not where
    // it sits: a re-hoist of one version re-keyed every project reaching it
    // (D-140). Where it sits decides what it resolves; that is the edges.
    // The root and a workspace keep their path, which is who they are.
    material.push(`${p === '' || e.isWorkspace ? p : installName(p)}\0${e.resolution}`)
    edges.push([])
  }
  // npm links a `file:` directory, or with `install-links=true` copies it,
  // so what a task reads is its content now, which the lockfile does not
  // record: an edit to it replayed a stale hit.
  for (const dir of lock.fileDirs) {
    const own = `\nfile\0${files.get(dir) ?? ''}`
    const i = index.get(dir)
    for (const [p, e] of lock.packages) {
      if (e.copyOf === dir || (i === undefined && e.link === dir)) material[index.get(p)!] += own
    }
    if (i !== undefined) material[i] += own
  }
  for (const [p, e] of lock.packages) {
    const from = index.get(p)!
    if (e.link !== undefined) {
      const target = index.get(e.link)
      if (target !== undefined) edges[from]!.push(target)
      else material[from] += `\nlink\0${e.link}`
      continue
    }
    for (const [name, spec] of e.deps) {
      const target = resolve(lock, p, name)
      if (target !== undefined) edges[from]!.push(index.get(target)!)
      else material[from] += `\nunresolved\0${name}\0${spec}`
    }
  }
  const digests = reachDigests({ material, edges })
  const out = new Map<string, string>()
  // The global digest rides as DATA: Bun's xxHash3 reads only the low 32
  // bits of a seed, so two lockfiles' globals could share one (item 682).
  const global = Bun.hash.xxHash3(lock.global).toString(16).padStart(16, '0')
  for (const [p, e] of lock.packages) {
    if (p !== '' && !e.isWorkspace) continue
    out.set(
      p === '' ? '.' : p,
      Bun.hash
        .xxHash3(`${global}\0${digests[index.get(p)!]!}`)
        .toString(16)
        .padStart(16, '0'),
    )
  }
  return out
}

/**
 * The root's and each workspace's dependencies that resolve, by Node's
 * walk, to a `link: true` entry pointing at the root or a workspace: an
 * installed entry is a dep, a peer with none of the same name a peer.
 */
export function importerLinks(lock: Lockfile): ReadonlyMap<string, LockfileImporter> {
  const out = new Map<string, LockfileImporter>()
  for (const [p, e] of lock.packages) {
    if (p !== '' && !e.isWorkspace) continue
    const dir = p === '' ? '.' : p
    const links = { deps: {} as Record<string, string>, peers: {} as Record<string, string> }
    for (const name of e.deps.keys()) {
      const key = resolve(lock, p, name)
      const link = key === undefined ? undefined : lock.packages.get(key)!.link
      if (link === undefined) continue
      const target = lock.packages.get(link)
      if (target === undefined || (link !== '' && !target.isWorkspace)) continue
      const targetDir = link === '' ? '.' : link
      if (targetDir !== dir) links[e.peers.has(name) ? 'peers' : 'deps'][name] = targetDir
    }
    out.set(dir, links)
  }
  return out
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
function installName(p: string): string {
  const i = p.lastIndexOf('node_modules/')
  return i === -1 ? p : p.slice(i + 'node_modules/'.length)
}
