# `src/workspace/package-graph.ts` — workspace dep graph

## Purpose

Build the workspace-internal dependency graph from each project's
`package.json`. Used by `buildTaskGraph` to resolve `'^name'` edges
and by `workspace/filter.ts` for the `pkg...` / `...pkg` filter
traversals.

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
  `devDependencies`, `optionalDependencies` and the task edges — what
  the package has installed for itself.
- **reach** (`transitiveDeps` / `transitiveDependents`, what
  `--filter pkg...` and `--affected` read): order plus
  `peerDependencies`. A peer is provided by whoever consumes the
  package and is never linked into its own `node_modules`, so it is
  not a build-order edge (Turbo reads no peers at all), and peers are
  the one bucket that routinely closes a cycle — medusa's test-utils
  peers on medusa, which depends on it through analytics; as an order
  edge that was a task cycle (2026-09-11). A change in the peer can
  still break the package that peers on it, so it stays affected.

The graph is precomputed once per `vx run` invocation:

- The direct-deps adjacency is materialized eagerly; `directDeps`
  reads straight from it.
- `transitiveDeps` / `transitiveDependents` are memoized lazy
  functions backed by a DFS with cycle protection (a hypothetical
  cyclic workspace doesn't loop forever; it just returns the
  reachable subset).

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
- **Doesn't detect package-level cycles.** Cycles within the
  workspace package graph itself are pathological but legal in
  package managers. The cycle protection above means traversal
  terminates; whether the task graph cycles is detected at task-
  graph build time.

## Tests

`tests/package-graph.test.ts`:

- empty workspace.
- two projects, one depends on the other (directs + transitive).
- `directDeps` returns immediate workspace deps only, sorted; `[]`
  for unknown names.
- diamond (a → b, a → c, both → d). transitiveDeps(a) = [b, c, d].
- transitiveDependents inverts correctly.
- external (non-workspace) deps are ignored.
- self-reference in a dep is skipped.
- all four dep buckets are scanned; a peer reaches but does not order.
- a peer that closes a cycle is no cycle for the build order.

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
