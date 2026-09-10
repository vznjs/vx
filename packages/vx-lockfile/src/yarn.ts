// yarn.lock → one digest per workspace over the packages it can reach.
// Two generations, one graph. Berry (yarn 2+) is YAML: each entry is keyed
// by the descriptors it satisfies (`"foo@npm:^1.0.0, foo@npm:^1.2.0":`),
// carries `resolution`, `dependencies` / `peerDependencies` (name →
// range) and `checksum`; a workspace is `"a@workspace:packages/a"`. A
// dependency `bar: "npm:^2"` resolves to the entry keyed `bar@npm:^2`.
// Classic (yarn 1) is its own text format: `"foo@^1.0.0", "foo@^1.2.0":`
// then indented `version`, `resolved`, `integrity` and `dependencies:`
// with `bar "^2"` lines; classic has no workspace entries, so workspaces
// resolve from their own `package.json` — which the digest reads from the
// lockfile's root descriptors only, so a workspace's digest is the root's
// reach through the descriptors the file resolves.

import { reachDigests } from '@vzn/vx'

export interface Lockfile {
  readonly generation: 'berry' | 'classic'
  /** entry id (the resolution, or the first descriptor) → entry */
  readonly entries: ReadonlyMap<string, Entry>
  /** descriptor (`name@range`) → entry id */
  readonly descriptors: ReadonlyMap<string, string>
  /** workspace dir → entry id (berry only) */
  readonly workspaces: ReadonlyMap<string, string>
  readonly global: string
}

export interface Entry {
  readonly deps: ReadonlyMap<string, string>
  /** resolution + checksum / version + resolved + integrity */
  readonly resolution: string
}

type Json = Record<string, unknown>

export function parseLockfile(text: string): Lockfile {
  const head = text.slice(0, 400)
  if (/^# yarn lockfile v1/m.test(head)) return parseClassic(text)
  if (/^__metadata:/m.test(head) || /^\s*version: \d/m.test(head)) return parseBerry(text)
  throw new Error(
    'yarn.lock: neither a classic (`# yarn lockfile v1`) nor a berry (`__metadata`) lockfile',
  )
}

function parseBerry(text: string): Lockfile {
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch (err) {
    throw new Error(`yarn.lock: ${err instanceof Error ? err.message : String(err)}`)
  }
  const d = record(doc)
  if (d === undefined) throw new Error('yarn.lock: not a YAML document')
  const entries = new Map<string, Entry>()
  const descriptors = new Map<string, string>()
  const workspaces = new Map<string, string>()
  for (const [keys, raw] of Object.entries(d)) {
    if (keys === '__metadata') continue
    const e = record(raw) ?? {}
    const resolution = typeof e['resolution'] === 'string' ? e['resolution'] : keys
    entries.set(resolution, {
      deps: depsOf(e, ['dependencies', 'peerDependencies']),
      resolution: `${resolution}\0${typeof e['checksum'] === 'string' ? e['checksum'] : ''}`,
    })
    for (const k of keys.split(',')) descriptors.set(k.trim(), resolution)
    const ws = resolution.indexOf('@workspace:')
    if (ws !== -1) workspaces.set(resolution.slice(ws + '@workspace:'.length), resolution)
  }
  const meta = record(d['__metadata']) ?? {}
  return {
    generation: 'berry',
    entries,
    descriptors,
    workspaces,
    global: JSON.stringify({ version: meta['version'], cacheKey: meta['cacheKey'] }),
  }
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
    entries.set(id, {
      deps,
      resolution: `${fields['version'] ?? ''}\0${fields['resolved'] ?? ''}\0${fields['integrity'] ?? ''}`,
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
  return { generation: 'classic', entries, descriptors, workspaces: new Map(), global: 'classic' }
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

function depsOf(e: Json, fields: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const field of fields) {
    const deps = record(e[field])
    if (deps === undefined) continue
    for (const [name, spec] of Object.entries(deps)) out.set(name, String(spec))
  }
  return out
}

function record(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/**
 * `bar` + `npm:^2` → the entry keyed `bar@npm:^2`; classic: `bar@^2`. A
 * bare range gets berry's `npm:` prefix. A `workspace:` range resolves to
 * the workspace entry of that name whatever the range says (`*`, `^`, a
 * path) — berry lists the range among the keys, but the name is enough.
 */
function resolveDescriptor(lock: Lockfile, name: string, range: string): string | undefined {
  const direct = lock.descriptors.get(`${name}@${range}`)
  if (direct !== undefined) return direct
  if (lock.generation !== 'berry') return undefined
  if (range.startsWith('workspace:')) {
    for (const id of lock.workspaces.values()) if (id.startsWith(`${name}@workspace:`)) return id
    return undefined
  }
  return range.includes(':') ? undefined : lock.descriptors.get(`${name}@npm:${range}`)
}

/**
 * Every workspace's digest. Berry: one node per entry, workspaces among
 * them, keyed by dir. Classic: the file has no workspace entries, so the
 * one digest is the root's (`.`) over every entry the file resolves —
 * coarse, and honest about what classic records.
 */
export function importerDigests(lock: Lockfile): ReadonlyMap<string, string> {
  const index = new Map<string, number>()
  const material: string[] = []
  const edges: number[][] = []
  for (const [id, e] of lock.entries) {
    index.set(id, material.length)
    material.push(e.resolution)
    edges.push([])
  }
  for (const [id, e] of lock.entries) {
    const from = index.get(id)!
    for (const [name, range] of e.deps) {
      const target = resolveDescriptor(lock, name, range)
      if (target !== undefined) edges[from]!.push(index.get(target)!)
      else material[from] += `\nunresolved\0${name}\0${range}`
    }
  }
  const digests = reachDigests({ material, edges })
  const seed = Bun.hash.xxHash3(lock.global)
  const out = new Map<string, string>()
  const fold = (h: string) => Bun.hash.xxHash3(h, seed).toString(16).padStart(16, '0')
  if (lock.generation === 'classic') {
    let h = Bun.hash.xxHash3('classic', seed)
    for (const d of [...digests].sort()) h = Bun.hash.xxHash3(d, h)
    out.set('.', h.toString(16).padStart(16, '0'))
    return out
  }
  for (const [dir, id] of lock.workspaces) out.set(dir, fold(digests[index.get(id)!]!))
  return out
}
