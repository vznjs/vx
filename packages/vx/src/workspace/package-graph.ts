import path from 'node:path'
import type { ProjectMeta } from './workspace.js'

export interface PackageGraph {
  /** Immediate workspace deps the package builds AFTER (sorted): every bucket but peers. */
  directDeps: (name: string) => string[]
  /** All transitive workspace deps a change can reach the package through — peers included. */
  transitiveDeps: (name: string) => string[]
  /** All transitive workspace dependents (packages a change here can reach) — peers included. */
  transitiveDependents: (name: string) => string[]
}

/**
 * `taskEdges`: project → the projects its tasks name in a cross-project
 * `dependsOn` (`e2e` → `app` from `dependsOn: ['app#build']`). A dependent
 * the manifest does not know but the task graph does; without it
 * `--filter '...app'` never selected `e2e`, and a CI that runs "what
 * changed and everything depending on it" silently left it out
 * (2026-09-10). The `^task` walk still reads `directDeps`, which carries
 * both — a task edge IS a dependency.
 */
export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>,
): PackageGraph {
  const byName = new Map<string, ProjectMeta>()
  const byDir = new Map<string, ProjectMeta>()
  for (const p of projects) {
    byName.set(p.name, p)
    byDir.set(path.resolve(p.dir), p)
  }
  const linked = linkedTarget(byName, byDir)

  // Two adjacencies. ORDER (`directDeps`, the `^task` walk) is what the
  // package imports at build time: dependencies, devDependencies,
  // optionalDependencies, the task edges, and a workspace peer that does
  // not close a cycle. REACH (the transitive closures `--filter pkg...`
  // and `--affected` read) is ORDER plus every workspace peer.
  //
  // A peer on a workspace sibling is an import that resolves to that
  // sibling's build: every package manager links or hoists it (pnpm's
  // `linkWorkspacePackages`, the hoisted root of bun/npm/yarn), and
  // TanStack/router's `router-devtools-core` peers on `router-core` and
  // type-checks against its `dist` — Nx orders `^build` on the peer,
  // vx built the devtools first and failed (2026-09-11). But peers are
  // the one bucket that routinely cycles (medusa's test-utils peers on
  // medusa, which dev-depends on it through analytics; Turbo, which
  // reads no peers, runs it; an unconditional order edge made `^build`
  // a task cycle, 2026-09-11), so a peer edge that would close a cycle
  // through the order graph is reach only: the consumer above provides
  // that peer.
  //
  // Which edge of a MUTUAL two-peer cycle stays is stable across runs,
  // and the PACKAGE sort below is what makes it so: the first package
  // in name order keeps its edge, whatever order the projects arrive
  // in. The per-package peer sort provides none of that — measured
  // (item 571), both manifest orders give identical graphs in every
  // arrangement tried, because `reaches(peer, p)` walks edges INTO `p`
  // and adding an edge OUT of `p` cannot change it. It stays as cheap
  // insurance against a future rule that does depend on it; it is not
  // what the stability rests on.
  const directDeps = new Map<string, string[]>()
  const reachDeps = new Map<string, string[]>()
  const order = new Map<string, Set<string>>()
  const peers = new Map<string, Set<string>>()
  const sorted = [...projects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const p of sorted) {
    const own = new Set<string>()
    for (const name of taskEdges?.get(p.name) ?? []) {
      if (name !== p.name && byName.has(name)) own.add(name)
    }
    const optional = bucket(p.packageJson.optionalDependencies)
    const prod = bucket(p.packageJson.dependencies)
    const dev = bucket(p.packageJson.devDependencies)
    const add = (key: string, spec: unknown, installed: boolean, into: Set<string>): void => {
      if (typeof spec !== 'string') return
      const target = linked(key, spec.trim(), p.dir, installed)
      if (target !== undefined && target !== p.name) into.add(target)
    }
    // Which entry is installed when a key sits in more than one field,
    // measured with bun 1.4, npm 10, yarn 1 and pnpm 12 (2026-09-24): bun
    // and npm take devDependencies, then optionalDependencies, then
    // dependencies; yarn and pnpm take optionalDependencies, then
    // dependencies, then devDependencies. vx cannot tell which manager
    // installed the tree, so either winner linking is an edge: a spare
    // edge costs order, a missing one a stale hit. A dev or optional
    // entry wins under one order or the other; a prod entry loses to an
    // optional one under both.
    for (const key in dev) add(key, dev[key], true, own)
    for (const key in optional) add(key, optional[key], true, own)
    for (const key in prod) if (!Object.hasOwn(optional, key)) add(key, prod[key], true, own)
    order.set(p.name, own)
    // A peer is not installed by the package that declares it: when an
    // installed entry names the same key, that entry is what resolves
    // (turborepo#12640: a registry `buffer@^6` dev dependency beside a
    // `workspace:*` peer on it installs the registry copy in all four).
    // Alone, a peer on a sibling resolves to the sibling whatever its
    // range, since bun and yarn hoist the workspace copy (npm refuses an
    // unmet one; pnpm 12 fetched it from the registry).
    const peer = new Set<string>()
    const peerDeps = bucket(p.packageJson.peerDependencies)
    for (const key in peerDeps) {
      if (!Object.hasOwn(optional, key) && !Object.hasOwn(prod, key) && !Object.hasOwn(dev, key)) {
        add(key, peerDeps[key], false, peer)
      }
    }
    peers.set(p.name, peer)
  }
  // `to` reaches `from` through the order edges so far ⇒ from → to
  // would close a cycle.
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>([start])
    const stack = [start]
    while (stack.length > 0) {
      for (const next of order.get(stack.pop()!) ?? []) {
        if (next === goal) return true
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    return false
  }
  for (const p of sorted) {
    const own = order.get(p.name)!
    for (const peer of [...peers.get(p.name)!].sort()) {
      if (!own.has(peer) && !reaches(peer, p.name)) own.add(peer)
    }
  }
  for (const p of sorted) {
    const own = order.get(p.name)!
    directDeps.set(p.name, [...own].sort())
    reachDeps.set(p.name, [...new Set([...own, ...peers.get(p.name)!])].sort())
  }

  // Reverse adjacency: who declares X as a workspace dep.
  const directDependents = new Map<string, string[]>()
  for (const [name, deps] of reachDeps) {
    for (const d of deps) {
      const arr = directDependents.get(d)
      if (arr) arr.push(name)
      else directDependents.set(d, [name])
    }
  }
  for (const arr of directDependents.values()) arr.sort()

  // Set-union DFS closures are O(P²) entries on dense layered graphs
  // (same disease the scheduler's reachOf had — 68 ms at 1090
  // projects). Bitset closures swept in topo order are O(E·P/32),
  // and indexing projects in sorted-name order means materializing a
  // closure is a single ascending bit-scan — already sorted, no
  // per-call sort. Package graphs (unlike task graphs) may legally
  // contain cycles; the bitset sweep requires a DAG, so a cycle
  // (detected by the Kahn pass not draining) falls back wholesale to
  // a per-query reachability search for that rare case.
  const names = [...byName.keys()].sort()
  const index = new Map<string, number>()
  for (let i = 0; i < names.length; i++) index.set(names[i]!, i)

  function bitsetClosures(edges: Map<string, string[]>): Uint32Array | null {
    const n = names.length
    const words = (n + 31) >>> 5
    const adj: number[][] = Array.from({ length: n }, () => [])
    const indegree = new Uint32Array(n)
    for (const [from, tos] of edges) {
      const fi = index.get(from)!
      for (const to of tos) {
        const ti = index.get(to)
        if (ti === undefined) continue
        adj[fi]!.push(ti) // edge from → to; closure(from) ⊇ {to} ∪ closure(to)
        indegree[ti]!++
      }
    }
    const topo = new Int32Array(n)
    let head = 0
    let tail = 0
    for (let i = 0; i < n; i++) if (indegree[i] === 0) topo[tail++] = i
    while (head < tail) {
      const v = topo[head++]!
      for (const t of adj[v]!) if (--indegree[t]! === 0) topo[tail++] = t
    }
    if (tail < n) return null // cycle — caller falls back to DFS
    const closure = new Uint32Array(n * words)
    for (let t = tail - 1; t >= 0; t--) {
      const i = topo[t]!
      const base = i * words
      for (const d of adj[i]!) {
        closure[base + (d >>> 5)]! |= 1 << (d & 31)
        const dbase = d * words
        for (let w = 0; w < words; w++) closure[base + w]! |= closure[dbase + w]!
      }
    }
    return closure
  }

  // Cyclic fallback: everything reachable from `name` via ≥1 edge (so a
  // node inside a cycle includes itself). Deliberately a self-contained
  // per-query search rather than a memoized recursion over sub-results:
  // in a cycle the back-edge contributes nothing, so a shared recursion
  // computes TRUNCATED closures for the nodes below it and caching those
  // makes every later answer depend on which node was asked for first.
  function reachableFrom(name: string, edges: Map<string, string[]>): string[] {
    const seen = new Set<string>()
    const stack = [...(edges.get(name) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const d of edges.get(cur) ?? []) stack.push(d)
    }
    return [...seen].sort()
  }

  // The closures are built on the FIRST query, not here: an unscoped run
  // seeds every project and never asks for a transitive set, and neither
  // does a `^task` walk (it reads `directDeps`). Building both closures
  // eagerly was 12 ms of a 240 ms warm run at 1000 projects × 30 deps
  // (profiled 2026-09-09) for answers nobody read.
  function makeAccessor(edges: Map<string, string[]>): (name: string) => string[] {
    const memo = new Map<string, string[]>()
    let closures: Uint32Array | null | undefined
    const words = (names.length + 31) >>> 5
    return (name) => {
      const cached = memo.get(name)
      if (cached) return cached
      if (closures === undefined) closures = bitsetClosures(edges)
      if (closures === null) {
        const result = reachableFrom(name, edges)
        memo.set(name, result)
        return result
      }
      const i = index.get(name)
      if (i === undefined) return []
      const base = i * words
      const out: string[] = []
      for (let w = 0; w < words; w++) {
        let v = closures[base + w]!
        while (v !== 0) {
          const bit = 31 - Math.clz32(v & -v)
          out.push(names[(w << 5) + bit]!)
          v &= v - 1
        }
      }
      memo.set(name, out)
      return out
    }
  }

  return {
    directDeps: (name) => directDeps.get(name) ?? [],
    transitiveDeps: makeAccessor(reachDeps),
    transitiveDependents: makeAccessor(directDependents),
  }
}

function bucket(field: unknown): Readonly<Record<string, unknown>> {
  return typeof field === 'object' && field !== null ? (field as Record<string, unknown>) : {}
}

// The ranges a manifest carries, in the part of npm's grammar (node-semver)
// where `Bun.semver.satisfies` answers as npm does: `||`-joined sets, each
// a hyphen range, one comparator, or two or more `<`/`>` bounds, over
// versions whose wildcards trail (`1.x`, `1.2.*`). Bun 1.4.2 answers true
// for text that is no range at all (`latest`, `npm:foo@1`, `github:a/b`,
// `../x`), ORs bare comparators npm ANDs (`1 2`), and reads `>x` and a
// leading wildcard (`x.3.1`) its own way; a spec outside this grammar
// counts as unmet. One corner inside it still differs (item 831): a
// prerelease at a `<` bound over a partial (`<3.x`, `<3.1`) or at a hyphen
// range's partial end, beside a lower bound naming that prerelease's own
// version — `3.0.0-beta` against `>=3.0.0-alpha <3.x` — Bun admits and npm
// does not. bun installs by the first answer and the others by the second,
// so neither is right everywhere; the graph takes Bun's. The playground's
// port (packages/vx-docs, src/playground/shim/semver.ts) is held to Bun
// over this grammar.
const W = String.raw`[xX*]`
const PRE = String.raw`(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`
const NUMERIC = String.raw`[vV]?\d+(?:\.${W}(?:\.${W})?|\.\d+(?:\.${W}|\.\d+${PRE})?)?`
const SINGLE = String.raw`(?:(?:[<>]=?|~>?|\^)\s*${NUMERIC}|=?\s*(?:${NUMERIC}|${W}(?:\.${W}){0,2}))`
const BOUND = String.raw`[<>]=?\s*${NUMERIC}`
const SET = String.raw`(?:${NUMERIC}\s+-\s+${NUMERIC}|${BOUND}(?:\s+${BOUND})+|${SINGLE})`
export const SEMVER_RANGE = new RegExp(String.raw`^(?:${SET}(?:\s*\|\|\s*${SET})*)?$`)
/** `<name>[@<range>]` after `npm:` or `workspace:`; the name may be scoped. */
const ALIAS = /^(@[^@/]+\/[^@/]+|[^@/.][^@/]*)(?:@(.*))?$/
const PATH_PROTOCOLS = ['file:', 'link:', 'portal:'] as const
const MAY_POINT_ELSEWHERE = /^(?:workspace:|npm:|file:|link:|portal:|\.\.?\/|\/)/

/**
 * The workspace package a manifest entry resolves to, or undefined when
 * the package manager installs it from elsewhere. `installed` is false
 * for a peer, which the hoisted workspace copy under its key provides
 * whatever the spec. The rule and its measurements are
 * docs/modules/package-graph.md § Which entries are edges.
 */
function linkedTarget(
  byName: ReadonlyMap<string, ProjectMeta>,
  byDir: ReadonlyMap<string, ProjectMeta>,
): (key: string, spec: string, fromDir: string, installed: boolean) => string | undefined {
  // A monorepo repeats a few ranges and versions thousands of times, and
  // the grammar test and `Bun.semver` cost about a microsecond a call:
  // unmemoised they tripled the graph build at 1000 projects × 30 deps.
  const isRange = new Map<string, boolean>()
  const range = (spec: string): boolean => {
    let ok = isRange.get(spec)
    if (ok === undefined) isRange.set(spec, (ok = SEMVER_RANGE.test(spec)))
    return ok
  }
  const satisfiedBy = new Map<string, Map<string, boolean>>()
  // A dist-tag (`latest`) is no range, and bun, npm, yarn and pnpm all
  // installed it from the registry beside a matching workspace package.
  const satisfies = (p: ProjectMeta, spec: string): boolean => {
    if (spec === '*' || spec === '') return true
    const version = p.packageJson.version
    if (typeof version !== 'string' || !range(spec)) return false
    let memo = satisfiedBy.get(version)
    if (memo === undefined) satisfiedBy.set(version, (memo = new Map()))
    let ok = memo.get(spec)
    if (ok === undefined) memo.set(spec, (ok = Bun.semver.satisfies(version, spec)))
    return ok
  }
  const named = (name: string, spec: string): string | undefined => {
    const p = byName.get(name)
    return p !== undefined && satisfies(p, spec) ? name : undefined
  }
  const atPath = (fromDir: string, rel: string): string | undefined =>
    byDir.get(path.resolve(fromDir, rel))?.name
  return (key, spec, fromDir, installed) => {
    if (spec === 'workspace:*') return named(key, '*')
    // Only a protocol or a path points a key at another package; every
    // other spec (a range, a tag, a URL) is decided by the key.
    if (!MAY_POINT_ELSEWHERE.test(spec)) {
      const local = byName.get(key)
      if (local === undefined) return undefined
      // A catalog entry's range lives where the graph does not read
      // (`pnpm-workspace.yaml`, bun's root `catalog`): it keeps the edge.
      if (!installed || spec.startsWith('catalog:')) return key
      return satisfies(local, spec) ? key : undefined
    }
    if (spec.startsWith('workspace:')) {
      const rest = spec.slice('workspace:'.length)
      if (rest === '^' || rest === '~') return named(key, '*')
      if (range(rest)) return named(key, rest)
      const alias = ALIAS.exec(rest)
      if (alias !== null) return named(alias[1]!, alias[2] ?? '*')
      return atPath(fromDir, rest)
    }
    if (spec.startsWith('npm:')) {
      // bun links a satisfied alias; npm and yarn fetch it from the
      // registry. The edge is the spare one, as above.
      const alias = ALIAS.exec(spec.slice('npm:'.length))
      return alias === null ? undefined : named(alias[1]!, alias[2] ?? '*')
    }
    for (const protocol of PATH_PROTOCOLS) {
      if (spec.startsWith(protocol)) return atPath(fromDir, spec.slice(protocol.length))
    }
    // A bare `./`, `../` or `/` path is a directory to bun, npm and pnpm.
    return atPath(fromDir, spec)
  }
}
