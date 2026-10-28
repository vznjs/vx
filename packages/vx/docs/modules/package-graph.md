# `src/workspace/package-graph.ts` — project dep graph

## Purpose

Build the project dependency graph from the edges plugins supply: a
`discover` entry's `deps` and `reach` (`ProjectMeta.deps` / `.reach`,
set by `linkDiscoveredEdges`), plus, for selection, `vx watch` and the
dependency rules, the cross-project `pkg#task` edges of the task
configs. The graph `'^name'` resolves against has no task edges: a run
builds it before configs load. Core reads no edge from a manifest; the lockfile
plugins (`@vzn/vx-lockfile`'s `bun()`, `pnpm()`, `npm()`, `yarn()`)
supply what the package manager installed. Used by `buildTaskGraph` to
resolve `'^name'` edges (`directDeps`), by `workspace/filter.ts` for the
`pkg...` / `...pkg` traversals and `--affected`'s dependents
(`transitiveDeps` / `transitiveDependents`), and by `vx watch` to widen
its scope to each watched project's transitive deps.

## Public surface

```ts
export interface PackageGraph {
  readonly edgeSource: boolean // some `discover` entry carried `deps`
  directDeps: (name: string) => string[] // immediate deps (sorted)
  transitiveDeps: (name: string) => string[] // all transitive deps
  transitiveDependents: (name: string) => string[] // all transitive dependents
}

export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>, // project → projects its tasks name in a cross-project dependsOn
): PackageGraph

// dependency-rules.ts: throws VX_E_DEPENDENCY_RULE naming every broken edge
export function checkDependencyRules(
  rules: readonly DependencyRule[],
  projects: readonly string[],
  tags: ReadonlyMap<string, readonly string[]>, // each project's config tags
  graph: PackageGraph, // built with the task edges
): void
```

`checkDependencyRules` is `vx lock`'s check of `run.rules.dependencies`
(lock-only, 2026-10-13): for each project a rule's `from` selects,
each `directDeps` entry must match an `allow` selector when `allow` is
given, and no `deny` one. A selector is `tag:<glob>` or a name glob
(`compileNameGlob`, `--filter`'s matcher).

`directDeps` is the adjacency `buildTaskGraph` walks for `'^name'`
frontier expansion; `transitiveDeps` / `transitiveDependents` serve
`workspace/filter.ts`'s `pkg...` / `...pkg` traversals.

## Algorithm

Two adjacencies, each skipping self-references and names that are no
project:

- **order** (`directDeps`, what `'^name'` walks): a plugin's `deps` and
  the task edges.
- **reach** (`transitiveDeps` / `transitiveDependents`, what
  `--filter pkg...` and `--affected` read): order plus a plugin's
  `reach`, which never orders a build (the lockfile plugins put a
  workspace peer, or a workspace package the root installs, there when
  it would close an order cycle).

**The edge source.** `edgeSource` is true when any project carries
`deps`, even an empty list: a `discover` entry with `deps` makes the
workspace one (rule 4 of
`design/language-agnostic-core-2026-10.md`). Without one,
`buildTaskGraph` refuses a `^task` (`VX_E_DEPENDS_ON`, "`<id>: ^<task>`
needs project edges; add pnpm()/bun()/npm()/yarn() and install so its
lockfile exists, or a plugin that returns `deps`", led on the default
build by "`<project>` declares no build, so it is the default build,
whose"; a lockfile plugin
whose lockfile is absent gives no edges), the default `build`'s `^build` included: every `^`
would resolve to nothing, and its upstream would fold into no key, a
stale hit replayed green. With one, a project with no deps is a leaf
and its `^task` resolves to nothing, as a shared template needs. Reach
and task edges supply no `^` edge, so neither makes an edge source.

`directDeps` reads an adjacency built with the graph. The two
transitive closures are built on the FIRST query, not with the graph:
an unscoped run seeds every project and never asks for one, and
neither does a `^task` walk, and building both eagerly was 12 ms of a
240 ms warm run at 1000 projects × 30 deps (profiled 2026-09-09) for
answers nobody read. A scoped run asks one or two seeds' deps, so
`transitiveDeps` answers its first 8 asks by a search from the seed
over the REACH lists it visits, each list built on demand (the same
set in the same order; `--filter pkg-500` at 1,000 projects, load
configs 18.4 → 11.3 ms median, #2323). Past those, and for every
`transitiveDependents` ask, a closure is a bitset per project, swept once in
Kahn topological order (O(E·P/32), where a set-union DFS was O(P²)
entries on a dense layered graph — 68 ms at 1090 projects), with
projects indexed in sorted-name order so materialising one answer is a
single ascending bit-scan, already sorted; each answer is memoised by
name. Project graphs may legally contain cycles and the sweep needs a
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

- **Doesn't read a manifest or a lockfile.** Edges are what plugins
  return; which manifest entries a manager links is the lockfile
  plugin's question, answered from what it installed.
- **Doesn't include external (non-project) deps.** Those reach a key
  through the lockfile plugin's claim.
- **Doesn't report project-level cycles.** A cycle in the plugin edges
  is legal; the Kahn pass notices one only to choose the per-query
  fallback, so traversal terminates; whether the task graph cycles is
  detected at task-graph build time.

## Tests

`tests/package-graph.test.ts`:

- a project that names ITSELF is not its own dependency
- an edge to a name not in the graph is no edge
- builds an empty graph from no projects
- a project carrying deps, even none, makes the graph an edge source
- directDeps returns only immediate deps, sorted
- walks transitive deps and dedupes them
- does not loop forever on a dep cycle
- a cycle does not poison the closure memo (results are query-order independent)
- a node outside the cycle still gets its full closure after a cycle query
- transitiveDependents walks the reverse direction
- transitiveDependents terminates on a 2-node cycle and includes the other node
- reach from a plugin is in both closures and orders nothing
- with no plugin supplying edges, `^build` fails naming the fix
- a run whose lock was written with an edge source refuses once the plugin is gone
- with an edge source, a leaf resolves `^build` to nothing and a dependent waits on its dep
- a workspace that writes no `^` runs with no edge source

The list is the suite's `it` names, pinned in order by
`tests/module-shape-drift.test.ts`.

## Replacing this module

The graph is consumed by name-lookup methods. Replacements should
preserve `PackageGraph` shape. A reasonable extension: **edge
metadata** — the plugin that supplied each edge, so `vx why` and
dependency rules can name it.
