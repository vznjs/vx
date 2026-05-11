# `package-graph.ts` — workspace dependency graph

## Purpose

Compute the dependency relationships _between workspace packages_ from
their `package.json` files. Provides a fast way to ask "what are the
transitive workspace deps of package X?"

## Public surface

```ts
export interface PackageGraph {
  byName: Map<string, ProjectMeta>
  directDeps: Map<string, string[]> // project name → direct workspace deps
  transitiveDeps: (name: string) => string[] // memoized
}

export function buildPackageGraph(projects: ProjectMeta[]): PackageGraph
```

## Construction rules

For each project:

- Look at `dependencies`, `devDependencies`, `peerDependencies`, and
  `optionalDependencies`. All four fields are equally treated.
- A dependency name is considered a _workspace_ dep only if there's
  another project in the workspace with that name. External npm
  packages are dropped here.
- Self-references (a project listing itself in its own deps) are
  filtered.
- Direct deps for a project are sorted alphabetically for determinism.

`transitiveDeps(name)`:

- Returns every workspace dep reachable through any number of `dep-of`
  edges.
- Memoized via `cache` map.
- Cycle-safe: if A → B → A, traversal terminates with each project
  including the other in its set (but not itself).
- Result is sorted before caching.

## What this does NOT do

- It doesn't read `package.json` from disk — `ProjectMeta` already
  carries it (loaded earlier by `workspace.ts`).
- It doesn't distinguish between `dependencies` and `devDependencies`.
  This matches user intent: any declared workspace dep relationship
  participates in task scheduling.
- It doesn't validate the `workspace:` protocol or pnpm-specific
  versioning. Any matching package name counts.
- It doesn't follow non-workspace deps (npm packages) — only links
  between workspace packages matter for task scheduling.

## Tests

`package-graph.test.ts` covers:

- Empty input → empty graph.
- Direct deps recorded only when the dep is in the workspace.
- Transitive walk with dedup.
- No infinite loop on a workspace-dep cycle.
- All four dependency-field types read.

## Replacing this module

The shape is simple and stable. Replacements might add:

- **Version-aware filtering** — only count deps that satisfy a
  `workspace:^x.y.z` range. Today everything counts because pnpm
  enforces this at install time.
- **Direct-only graphs** — currently we expose `directDeps` for
  reference but the task graph always uses `transitiveDeps`.
- **Reverse graph** — "who depends on me" lookups for incremental
  builds. Build on demand from `directDeps`.

Make sure consumers — primarily `task-graph.ts` — see the same
`directDeps` and `transitiveDeps()` API. The `byName` map is
informational and currently unused outside this module.
