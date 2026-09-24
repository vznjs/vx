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

export const SEMVER_RANGE: RegExp // the ranges handed to Bun.semver (below)
```

`directDeps` is the adjacency `buildTaskGraph` walks for `'^name'`
frontier expansion; `transitiveDeps` / `transitiveDependents` serve
`workspace/filter.ts`'s `pkg...` / `...pkg` traversals.

## Algorithm

For each project, scan the four dep buckets and keep the entries that
link another workspace project (skipping self-references; which
entries link is the next section). Two adjacencies come out of it:

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

## Which entries are edges

An entry is an edge when the package manager installs the workspace
package for it, not when its key names one: `"shared": "^1.0.0"` beside
a local `shared@2.0.0` installs the registry's 1.x (turborepo#4214),
and `"luigi": "workspace:../waluigi"` links `waluigi`, not the package
named `luigi` (turborepo#6744). The rule, measured against the registry
with bun 1.4.2, npm 10.9, yarn 1.22 and pnpm 12 (2026-09-24), one
install per spec:

- **`workspace:`** — `workspace:*`, `workspace:^`, `workspace:~` and a
  bare `workspace:` are the package the key names, any version. A
  range (`workspace:^1.2.0`) must be satisfied by that package's
  version (bun and pnpm refuse the install when it is not).
  `workspace:<name>@<range>` is an alias to `<name>`;
  anything else is a path from the declaring package's directory.
- **`file:`, `link:`, `portal:` and a bare `./`, `../` or `/` path** —
  the workspace package whose directory the path names; a tarball or
  any other directory is no edge.
- **`npm:<name>@<range>`** — `<name>`, when its version satisfies the
  range. bun links a satisfied alias; npm and yarn fetch it from the
  registry, so under them this edge is a spare one.
- **A range** (`^1.2.0`, `1.x`, `>=1 <2`, `1.0.0 - 2.0.0`, `*`, `""`) —
  the package the key names when its version satisfies the range,
  checked with `Bun.semver.satisfies`. `*` and `""` take any version,
  a prerelease or none; a package with no `version` satisfies nothing
  else, and a prerelease satisfies a range only as npm's `semver` says
  (`2.0.0-beta.1` is not `^2.0.0`). Padding is trimmed, as every
  manager does.
- **`catalog:`** — the package the key names: the catalog's range lives
  in `pnpm-workspace.yaml` or bun's root manifest, which the graph does
  not read (turborepo#10785 keeps this edge).
- **Anything else** — a dist-tag (`latest` came from the registry in
  all four), a git or tarball URL, an unmet range — is no edge.

`SEMVER_RANGE` is the range grammar. `Bun.semver.satisfies` answers
true for text that is no range (`latest`, `github:a/b`), ORs bare
comparators npm ANDs (`1 2`), and reads `>x` and a leading wildcard
(`x.3.1`) its own way, so a spec is handed to it only inside the part
of npm's grammar where the two agree: `||`-joined sets, each a hyphen
range, one comparator, or two or more `<`/`>` bounds, over versions
whose wildcards trail. A spec outside it counts as unmet. The site's
playground bundles this module without Bun; its port
(`packages/vx-docs/src/playground/shim/semver.ts`) is held to Bun over
exactly `SEMVER_RANGE` by
`packages/vx-docs/tests/playground-semver.test.ts`.

**A key in several fields.** The managers disagree which entry they
install: bun and npm take `devDependencies`, then
`optionalDependencies`, then `dependencies`; yarn and pnpm take
`optionalDependencies`, then `dependencies`, then `devDependencies`.
vx cannot tell which manager installed a checkout, so a key is an edge
when EITHER order's winner links: every `devDependencies` and
`optionalDependencies` entry counts, and a `dependencies` entry counts
unless `optionalDependencies` names the same key. A spare edge costs
ordering and a rebuild; a missing one is a stale hit.

**Peers.** A `peerDependencies` entry is not installed by the package
that declares it, so when an installed field names the same key, that
entry decides alone: a registry `buffer@^6` devDependency beside a
`workspace:*` peer on the local `buffer@0.0.1` installs the registry
copy in all four (turborepo#12640). Alone, a peer on a workspace key is
an edge whatever its spec, since bun and yarn hoist the workspace copy
and resolve the import to it even for an unmet range or a tag (npm
refuses to install an unmet peer); a path or alias spec still resolves
to its target.

**pnpm.** pnpm 9 and later default `link-workspace-packages` to false
and then link only `workspace:`, `file:` and `link:` specs: with pnpm
12 a satisfied `^2.0.0`, `*` and `npm:` alias all came from the
registry. Which pnpm and which setting installed a checkout is not in
anything the graph reads (the default moved with the major, and the
setting may sit in `.npmrc`, `pnpm-workspace.yaml` or the user's own
config), so under pnpm those specs stay edges: spare ones. The
lockfile knows (`pnpm-lock.yaml` records `link:` for a linked
importer); the graph is built before any plugin reads it.

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
  the project package.json hash. An entry naming a workspace package
  that the manager installs from the registry is one of them.
- **Doesn't read a lockfile or a catalog.** Which entries link is
  decided from the manifests alone (the section above).
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
- a `workspace:` path or alias links the package it points at, not its key (turborepo#6744)
- a `file:`, `link:`, `portal:` or bare path and a satisfied `npm:` alias link their target
- a range the local version does not satisfy is a registry dependency (turborepo#4214)
- an installed entry, not a peer on the same key, decides the edge (turborepo#12640)
- a key in two installed fields links when either precedence order installs the local copy
- `*` and `workspace:^` take any version; a tag, a URL or an unmet `workspace:` range do not
- a `catalog:` entry keeps the edge its key names (turborepo#10785)
- `vx run --dry=json`, `...pkg` and `--affected` follow the linked package, not the key

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
