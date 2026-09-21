# `src/workspace/package-graph.ts` — workspace dep graph

## Purpose

Build the workspace-internal dependency graph from each project's
`package.json`. Used by `buildTaskGraph` to resolve `'^name'` edges
(`directDeps`), by `workspace/filter.ts` for the `pkg...` / `...pkg`
traversals and `--affected`'s dependents (`transitiveDeps` /
`transitiveDependents`), and by `vx watch` to widen its scope to each
watched project's transitive deps.

## Public surface

```ts
export interface PackageGraph {
  directDeps: (name: string) => string[] // immediate workspace deps (sorted)
  transitiveDeps: (name: string) => string[] // all transitive deps
  transitiveDependents: (name: string) => string[] // all transitive dependents
}

export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>, // project → projects its tasks name in a cross-project dependsOn
): PackageGraph
```

`directDeps` is the adjacency `buildTaskGraph` walks for `'^name'`
frontier expansion; `transitiveDeps` / `transitiveDependents` serve
`workspace/filter.ts`'s `pkg...` / `...pkg` traversals.

## Algorithm

For each project, scan the four dep buckets and keep names that
resolve to another workspace project (skipping self-references). Two
adjacencies come out of it:

- **order** (`directDeps`, what `'^name'` walks): `dependencies`,
  `devDependencies`, `optionalDependencies`, the task edges, and a
  `peerDependencies` entry on a workspace sibling unless that edge
  would close a cycle through the order edges so far — what the
  package imports at build time.
- **reach** (`transitiveDeps` / `transitiveDependents`, what
  `--filter pkg...` and `--affected` read): order plus every
  workspace peer.

A peer on a sibling is an import that resolves to the sibling's build:
every package manager links or hoists it (pnpm's
`linkWorkspacePackages`, the hoisted root of bun, npm and yarn), and Nx
orders `^build` on it — TanStack/router's `router-devtools-core` peers
on `router-core` and type-checks against its `dist`; vx built the
devtools first and failed (2026-09-11). But peers are the one bucket
that routinely closes a cycle — medusa's test-utils peers on medusa,
which depends on it through analytics; Turbo, which reads no peers,
runs it, and an unconditional order edge was a task cycle
(2026-09-11) — so a peer edge that would close a cycle is reach only:
the consumer above provides that peer. Peers are tried in
(package, peer) name order, so which edge of a mutual peering stays is
the same on every run. A change in a peer always reaches the package
that peers on it, ordered or not.

`directDeps` reads an adjacency built with the graph. The two
transitive closures are built on the FIRST query, not with the graph:
an unscoped run seeds every project and never asks for one, and
neither does a `^task` walk, and building both eagerly was 12 ms of a
240 ms warm run at 1000 projects × 30 deps (profiled 2026-09-09) for
answers nobody read. A closure is a bitset per project, swept once in
Kahn topological order (O(E·P/32), where a set-union DFS was O(P²)
entries on a dense layered graph — 68 ms at 1090 projects), with
projects indexed in sorted-name order so materialising one answer is a
single ascending bit-scan, already sorted; each answer is memoised by
name. Package graphs may legally contain cycles and the sweep needs a
DAG: when the Kahn pass does not drain, every query in that direction
falls back to a self-contained per-query reachability search (a node
inside a cycle includes itself). Per query on purpose: in a cycle the
back edge contributes nothing, so a memoised recursion over
sub-results computes truncated closures for the nodes below it, and
caching those made every later answer depend on which node was asked
for first.

Output lists are sorted alphabetically for deterministic cache keys
and graph traversal.

## What this does NOT do

- **Doesn't include external (non-workspace) deps.** Those flow into
  the cache key via the workspace fingerprint (lockfile hash) and
  the project package.json hash.
- **Doesn't classify dep types beyond peer / not peer.** For the
  task graph `dependencies`, `devDependencies` and
  `optionalDependencies` are equivalent — each says "this package
  needs that one built first."
- **Doesn't report package-level cycles.** Cycles within the
  workspace package graph itself are pathological but legal in
  package managers. The Kahn pass notices one only to choose the
  per-query fallback, so traversal terminates; whether the task graph
  cycles is detected at task-graph build time.

## Tests

`tests/package-graph.test.ts`:

- a package that names ITSELF is not its own dependency
- builds an empty graph from no projects
- records direct workspace deps only when the dep is in the workspace
- directDeps returns only immediate workspace deps, sorted
- walks transitive deps and dedupes them
- does not loop forever on a workspace dep cycle
- a cycle does not poison the closure memo (results are query-order independent)
- a node outside the cycle still gets its full closure after a cycle query
- transitiveDependents walks the reverse direction
- transitiveDependents terminates on a 2-node cycle and includes the other node
- reads all four dependency fields: a workspace peer orders a build too
- a peer stays reach only when the peer already depends on the package
- two packages peering on each other keep one order edge, in name order
- a peer that closes a cycle is no cycle for the build order (medusa, 2026-09-11)

The list is the suite's `it` names, pinned in order by
`tests/module-shape-drift.test.ts`.

## Replacing this module

The graph is consumed by name-lookup methods. Replacements should
preserve `PackageGraph` shape. Reasonable extensions:

- **Edge metadata** — annotate each edge with the source bucket so
  tooling can answer "is `pkg-a`'s dep on `pkg-b` a dev or runtime
  dep?".
- **Conflict detection** — flag inconsistent version ranges (e.g.
  `pkg-a` requires `^1.0` while `pkg-b` requires `^2.0` of a third
  workspace package). Belongs in lint, not the runner, but the
  data is here.
