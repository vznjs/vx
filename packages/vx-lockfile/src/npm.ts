// package-lock.json (lockfileVersion 2 and 3) → one digest per workspace
// package over the packages it can reach. `packages` is keyed by
// node_modules path: `""` is the root manifest, `node_modules/foo` a
// hoisted package, `node_modules/foo/node_modules/bar` one nested under
// it, `packages/a` a workspace package, and `node_modules/a` a link to it
// (`link: true, resolved: "packages/a"`). A dependency `d` of the package
// at path `p` is `p/node_modules/d` when that key exists, else the nearest
// ancestor directory's, else `node_modules/d` — Node's own walk.

import { reachDigests } from '@vzn/vx'
import { depsOf, record, type Json } from './json.js'
import type { PruneScope } from './scope.js'

export interface Lockfile {
  readonly version: number
  /** path → entry */
  readonly packages: ReadonlyMap<string, Entry>
  /** Material every workspace folds. */
  readonly global: string
}

export interface Entry {
  readonly deps: ReadonlyMap<string, string>
  /** version + resolved + integrity — whatever pins the bytes; '' for a link */
  readonly resolution: string
  /** the path a `link: true` entry points at */
  readonly link: string | undefined
  readonly isWorkspace: boolean
}

export function parseLockfile(text: string): Lockfile {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`package-lock.json: ${err instanceof Error ? err.message : String(err)}`)
  }
  const d = record(doc)
  const version = d === undefined ? undefined : d['lockfileVersion']
  if (typeof version !== 'number') {
    throw new Error('package-lock.json: not an npm lockfile (no lockfileVersion)')
  }
  if (version < 2) {
    throw new Error(
      `package-lock.json: lockfileVersion ${version} has no \`packages\` map — npm 7+ writes version 2 or 3`,
    )
  }
  const packages = new Map<string, Entry>()
  for (const [p, raw] of Object.entries(record(d!['packages']) ?? {})) {
    const e = record(raw) ?? {}
    const link = e['link'] === true && typeof e['resolved'] === 'string' ? e['resolved'] : undefined
    packages.set(p, {
      deps: depsOf(e),
      resolution:
        link === undefined
          ? [e['version'], e['resolved'], e['integrity']]
              .map((v) => (typeof v === 'string' ? v : ''))
              .join('\0')
          : '',
      link,
      isWorkspace: p !== '' && !p.startsWith('node_modules/') && !p.includes('/node_modules/'),
    })
  }
  // Root `overrides` are not folded: what an override forced is the entry a
  // workspace reaches, and npm 10 does not write them here at all (D-142).
  const global = JSON.stringify({ lockfileVersion: version })
  return { version, packages, global }
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
export function importerDigests(lock: Lockfile): ReadonlyMap<string, string> {
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
 * The lockfile cut to the workspaces at `dirs` (`.` the root) and what
 * they reach through Node's walk, each at the path it held; the root
 * entry's `workspaces` becomes `workspaces`, the list the pruned root
 * manifest carries. Version 2's legacy `dependencies` tree is cut to the
 * same paths.
 */
export function pruneLockfile(text: string, scope: PruneScope): string {
  const { dirs, members, workspaces } = scope
  const lock = parseLockfile(text)
  const doc = JSON.parse(text) as Json
  const reached = new Set<string>()
  const visit = (p: string | undefined): void => {
    if (p === undefined || reached.has(p)) return
    const e = lock.packages.get(p)!
    if (members.has(p) && !dirs.has(p)) {
      throw new Error(`package-lock.json: ${p} is a workspace the subset leaves out`)
    }
    reached.add(p)
    if (e.link !== undefined) return visit(lock.packages.has(e.link) ? e.link : undefined)
    for (const name of e.deps.keys()) visit(resolve(lock, p, name))
  }
  for (const [p, e] of lock.packages) {
    const linked = e.link !== undefined && dirs.has(e.link)
    if (linked || dirs.has(p === '' ? '.' : p)) visit(p)
  }
  const packages = record(doc['packages'])!
  for (const p of Object.keys(packages)) if (!reached.has(p)) delete packages[p]
  const rootEntry = record(packages[''])
  if (rootEntry?.['workspaces'] !== undefined) rootEntry['workspaces'] = [...workspaces]
  const prune = (tree: unknown, base: string): void => {
    const deps = record(tree)
    if (deps === undefined) return
    for (const [name, sub] of Object.entries(deps)) {
      const p = `${base}node_modules/${name}`
      if (!reached.has(p)) delete deps[name]
      else prune(record(sub)?.['dependencies'], `${p}/`)
    }
  }
  prune(doc['dependencies'], '')
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
function installName(p: string): string {
  const i = p.lastIndexOf('node_modules/')
  return i === -1 ? p : p.slice(i + 'node_modules/'.length)
}
