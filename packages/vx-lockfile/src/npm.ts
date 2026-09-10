// package-lock.json (lockfileVersion 2 and 3) → one digest per workspace
// package over the packages it can reach. `packages` is keyed by
// node_modules path: `""` is the root manifest, `node_modules/foo` a
// hoisted package, `node_modules/foo/node_modules/bar` one nested under
// it, `packages/a` a workspace package, and `node_modules/a` a link to it
// (`link: true, resolved: "packages/a"`). A dependency `d` of the package
// at path `p` is `p/node_modules/d` when that key exists, else the nearest
// ancestor's, else `node_modules/d` — Node's own walk.

import { reachDigests } from '@vzn/vx'

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
  const root = record((record(d!['packages']) ?? {})[''])
  const global = JSON.stringify({ lockfileVersion: version, overrides: root?.['overrides'] })
  return { version, packages, global }
}

function depsOf(e: Json): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const field of DEP_FIELDS) {
    const deps = record(e[field])
    if (deps === undefined) continue
    for (const [name, spec] of Object.entries(deps)) out.set(name, String(spec))
  }
  return out
}

function record(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/** `p/node_modules/name`, up the ancestors, then `node_modules/name`. */
function resolve(lock: Lockfile, from: string, name: string): string | undefined {
  let base = from
  for (;;) {
    const key = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`
    if (lock.packages.has(key)) return key
    if (base === '') return undefined
    const i = base.lastIndexOf('/node_modules/')
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
    material.push(`${p}\0${e.resolution}`)
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
  const seed = Bun.hash.xxHash3(lock.global)
  for (const [p, e] of lock.packages) {
    if (p !== '' && !e.isWorkspace) continue
    out.set(
      p === '' ? '.' : p,
      Bun.hash.xxHash3(digests[index.get(p)!]!, seed).toString(16).padStart(16, '0'),
    )
  }
  return out
}
