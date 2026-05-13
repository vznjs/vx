# `src/workspace/package-graph.ts` — workspace dep graph

## Purpose

Build the workspace-internal dependency graph from each project's
`package.json`. Used by `buildTaskGraph` to resolve `'^name'` edges
and by `workspace/filter.ts` for the `pkg...` / `...pkg` filter
traversals.

## Public surface

```ts
export interface PackageGraph {
  byName: Map<string, ProjectMeta>
  directDeps: Map<string, string[]> // immediate workspace deps
  transitiveDeps: (name: string) => string[] // all transitive deps
  transitiveDependents: (name: string) => string[] // all transitive dependents
}

export function buildPackageGraph(projects: ProjectMeta[]): PackageGraph
```

## Algorithm

For each project, scan all four dep buckets — `dependencies`,
`devDependencies`, `peerDependencies`, `optionalDependencies` — and
keep names that resolve to another workspace project (skipping
self-references).

The graph is precomputed once per `vx run` invocation:

- `directDeps` is materialized eagerly.
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
- **Doesn't classify dep types** (dependencies vs devDependencies vs
  peerDependencies). For the task graph all four are equivalent —
  they all signal "this package needs that one to be present /
  built first."
- **Doesn't detect package-level cycles.** Cycles within the
  workspace package graph itself are pathological but legal in
  package managers. The cycle protection above means traversal
  terminates; whether the task graph cycles is detected at task-
  graph build time.

## Tests

`tests/package-graph.test.ts`:

- empty workspace.
- two projects, one depends on the other (directs + transitive).
- diamond (a → b, a → c, both → d). transitiveDeps(a) = [b, c, d].
- transitiveDependents inverts correctly.
- external (non-workspace) deps are ignored.
- self-reference in a dep is skipped.
- all four dep buckets are scanned.

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
