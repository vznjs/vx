# Plugin-named projects: a `discover` stage (2026-09-28, stream D)

**Status: shipped 2026-09-29 (G-54) for core and `turbo()`: the stage
(`discoverProjects`, `orchestrator/projects.ts`; `namedProject`,
`workspace/workspace.ts`) runs wherever a run or reading verb discovers
(run, `show`, `watch`, `info`, filters); `vx lock` and `vx init` read
members only. `turbo()` names the root for `//#task` (G-54); `nx()` names
every graph node with targets that core did not find (G-55), reading the
graph with the `cacheDir` the context carries. Leads from N
(`docs/history/ws-n.md`).**

## Why

Core finds projects one way: the package manager's member globs (and,
since D-39, a root `vx.config`). An integrated Nx repo does not list its
projects there. analogjs/analog (40cc8b4) keeps its libraries out of
`pnpm-workspace.yaml`; each is an Nx project by its `project.json`, and
some have a `package.json` no workspace lists. `nx()` reads Nx's graph
and knows all 21 `build` tasks, but its `project` stage visits only the
projects core discovered, so it attaches one. Owner scope (2026-09-28):
Turbo and Nx are the adoption paths, so this repo shape matters.

Principle 8 (seam over special case) rules out teaching core Nx's
`project.json`: the plugin already knows the graph. The seam is a way for
a plugin to name project directories.

## Shape

One hook on `VxPlugin`, run once after core's discovery and before any
config loads:

```ts
discover?(ctx: DiscoverContext): readonly { dir: string; name: string }[] | Promise<…>
interface DiscoverContext extends PluginContext {
  readonly projects: readonly ProjectMeta[] // core's, and earlier plugins'
}
```

- **Order** is declaration order, as everywhere: each plugin sees core's
  projects and the ones earlier plugins named.
- **A named directory becomes a `ProjectMeta`** exactly as a discovered
  member does: `configPath` by the same `findConfigFile`, `packageJson`
  read if the directory has one. With none, the meta carries `{ name }`
  only, and the key folds no manifest bytes for it (it has none).
- **The name is the plugin's.** A directory with a `package.json` whose
  `name` differs is refused, naming both: a project has one name, and a
  task id (`name#task`) must not depend on which path found it.
- **Refused at the boundary:** a directory outside the workspace root, a
  name core or an earlier plugin already holds (the duplicate-name
  refusal discovery gives today), a directory that is already a project
  under another name. A directory already found under the same name is a
  no-op.
- **Load-bearing:** a throw or a malformed return aborts the run with a
  `UserError` naming plugin and hook (pipeline rule 7).
- **Zero cost when absent:** no plugin declares `discover` ⇒ no loop.

## What does not change

- **Boundaries** (principle 6): a named project is a project like any
  other, so nested-project exclusion and the sandbox apply unchanged.
- **`--affected`**: containment by directory gives a changed file to its
  deepest owner, a named project included.
- **The package graph** takes edges from `package.json` dependencies and
  task edges; a named project with no manifest has only task edges, which
  is what `nx()` emits (`pkg#task` dependsOn from Nx's graph).
- **The key**: resolved-config hashing sees the tasks after `project`
  ran, as today.

## Open questions

1. `vx watch` re-discovers on a member-glob change; a plugin-named set
   changes when its source changes (`project.json` edits for `nx()`).
   Either `discover` returns the files its answer depends on, or watch
   re-runs discovery when a plugin's `project` inputs move (C/E).
2. `vx lock` records project configs by path; a named project with no
   `vx.config` records nothing, as a config-less member does today.
3. Does a named project need its own `package.json`-less identity in
   `vx info` / `vx show`? Proposed: the plugin's name, directory as usual.

## Slices

- D (workspace): `ProjectMeta` for a named directory, the boundary
  refusals, rows.
- C (plugin host / orchestrator): the stage in `prepare`, crash isolation,
  the zero-cost gate, the public types (H for `src/index.ts`).
- G/N (`nx()`): return every Nx graph node's `root` from `discover`.
