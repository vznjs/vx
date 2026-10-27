# Language-agnostic core (2026-10)

> **Status:** proposal. Owner decision (2026-10-14): core drops all
> package.json / package-manager logic. Builds on lock-only runs
> (`feat(lock)!: runs read only .vx/projects.lock.json`, in flight):
> only `vx lock` evaluates configs; workspace config, plugins and the
> `discover` / `project` / `graph` stages run live every run.

## What we're solving

Core knows JS packages in five ways: it finds projects through package
manager member globs, names them by `package.json#name`, derives `^task`
edges and `--affected` reach from manifest dependencies, folds each
project's `package.json` bytes into every key, and folds root lockfiles
and install settings into a workspace fingerprint. None of that is
orchestration. It moves to `@vzn/vx-lockfile`; core keeps directories,
configs, names, edges and keys as plain concepts.

## Access pattern

- `vx lock` (rare, after a config edit): walk for configs, evaluate,
  write the lock. May cost a tree walk.
- Every run / watch cycle / `--affected` (hot): read the lock, run the
  plugin stages, build the graph, key. Must not walk the tree.
- A project's name and edges are read per run; they change when a
  lockfile or `package.json` changes, which needs no `vx lock`.

## Rules

1. **A project is a directory holding a `vx.config.*`.** `vx lock` finds
   them with one `git ls-files -z --cached --others --exclude-standard`
   over `:(glob)**/vx.config.*` and `:(glob)**/.vx/workspace.*` (git
   ignore applied by git). A config at or under a nested `.vx/workspace.*`
   belongs to that workspace and is dropped. Existing file precedence
   (`PROJECT_CONFIG_FILENAMES`) picks one per directory. Outside git: a
   `Bun.Glob` scan that skips dot-directories, no ignore rules.
2. **A run takes core's projects from the lock, never walks.** A config
   added since `vx lock` is not a project until locked (`vx lock --check`
   in CI catches it); a locked directory whose config is gone is refused
   (X-144, kept). Plugin `discover` then adds or names projects, live.
3. **Name order:** `name` in the config, else a name a `discover` plugin
   gives, else the root-relative POSIX path; the root's path name is `//`
   (Turbo's spelling, already the root alias in filters and `dependsOn`).
   A name holding `#` or surrounding whitespace is refused (a path one
   says "set `name`"). Two projects with one name: `UserError` naming both
   directories. No "left out" warning path survives.
4. **Edges come only from plugins** (plus cross-project `pkg#task`
   `dependsOn`, as today). A `^task` in a workspace where no plugin
   supplies edges is a `UserError` at graph build ("`^build` needs project
   edges; add pnpm()/bun()/npm()/yarn() or a plugin that returns
   `deps`"). With an edge source, a project with no deps resolves `^task`
   to nothing, silently, as a leaf does today. Rationale: a silent empty
   `^` drops upstream folding, so a stale hit replays wrong bytes green
   (the worst failure class); an error per leaf would break shared
   templates. "`^` requires an edge source" is one rule and closes both.
5. **Core keys no package file.** No `package.json` part, no root
   fingerprint list. The lockfile plugin adds `package.json` as an input
   and claims the lockfile and install settings.
6. **`--affected` without a plugin:** a changed path goes to its deepest
   owning project (containment; the root project, if any, owns root
   files), then to task-graph dependents (cross-project `dependsOn`).
   A config file still keys every task of its project. A path no project
   owns selects nothing. No manifest diff, no root fan-out.

## Inventory: where core knows packages, and where it goes

Paths relative to `packages/vx/src`, at `d166cbe6d`.

**A. Membership and names → core config walk (rule 1-3) / vx-lockfile `discover`**

| Where                                                                                                                      | What                                                                                                             | Goes to                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `workspace/workspace.ts:21-58`                                                                                             | `PackageJson`, `Workspace.packageGlobs/catalogs`, `ProjectMeta.packageJson/catalogs`                             | deleted; `ProjectMeta = { name, dir, configPath }`                                            |
| `workspace/workspace.ts:257-532`                                                                                           | member globs, `!` patterns, `pnpm-workspace.yaml` / `workspaces` read, catalogs, unreached hints, manifest parse | deleted (lockfile importers replace globs)                                                    |
| `workspace/workspace.ts:620-760`                                                                                           | `loadWorkspace`, `memberBaseDirs`, `reachesManifest`, `memberDirs`                                               | deleted; config walk in `vx lock`                                                             |
| `workspace/workspace.ts:823-1018`                                                                                          | manifest read per member, nameless skip, duplicate-name skip/refusal, link dedupe                                | core: dup = error (rule 3); dedupe by realpath stays for config dirs                          |
| `workspace/workspace.ts:1022-1090`                                                                                         | `namedProject` package.json name check, `withCatalogs`                                                           | `discover` naming rules (below)                                                               |
| `orchestrator/projects.ts:99-125, 184-225, 242, 308`                                                                       | discovery entry, package closure, `//` → package name, `ctx.packageJson`                                         | lock dirs + `discover`; closure over project graph; `//` → root's name; `packageJson` dropped |
| `orchestrator/prepare.ts:262-271`                                                                                          | package graph, root by package name                                                                              | project graph                                                                                 |
| `cli/why.ts:177-180`                                                                                                       | reads root `package.json` for `//`                                                                               | root's resolved name                                                                          |
| `cli/watch.ts:177, 640-663, 706-738, 957`; `cli/watch-filter.ts:281, 313-328`; `cli/watch-set.ts:48`                       | re-discover on `package.json` / member dir changes                                                               | re-read on `.vx/projects.lock.json` change; re-run `discover` on a claimed file change        |
| `orchestrator/run.ts:1867-1873, 1919`; `cli/select.ts:531, 622`; `graph/task-graph.ts:611`; `workspace/filter.ts:135, 198` | messages naming `workspaces` / package names                                                                     | reworded                                                                                      |
| `workspace/config-schema.ts:1050-1058, 1093-1105`                                                                          | `name` refused as a foreign key; hints point at `workspaces`                                                     | `name` becomes a field; hints reworded                                                        |
| `cache/cache.ts:698`                                                                                                       | `MANIFESTS` marks a project dir                                                                                  | config filenames + `.vx/workspace.*`                                                          |
| `cli/init.ts:2-123, 557-564`; `workspace/migrate-scripts.ts`; `workspace/workspace.ts:134-255` (`findManifestRoot`)        | `vx init` from package.json scripts                                                                              | `@vzn/vx-migrate` (open question 1)                                                           |
| `private/vx-docs/src/playground/entry.ts:158-182`                                                                          | playground discovery + package graph                                                                             | follows core (parity test)                                                                    |

**B. Package edges → `discover` `deps`/`reach`, vx-lockfile**

| Where                                                                                                                                            | What                                                                                      | Goes to                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace/package-graph.ts:1-417`                                                                                                               | manifest buckets, peer cycle rule, catalogs, link/semver matching                         | vx-lockfile (edges read from the lockfile; peer cycle rule moves with it); core keeps a `ProjectGraph` built from plugin edges + task edges |
| `graph/task-graph.ts:272-699`; `workspace/filter.ts:238, 370-379`; `workspace/dependency-rules.ts:8-32`; `orchestrator/affected-tasks.ts:98-131` | `directDeps` / `transitive*` consumers                                                    | unchanged logic over `ProjectGraph`                                                                                                         |
| `cli/select.ts:326`, `cli/show.ts:199`, `cli/lock.ts:160-165`, `cli/workspace-config.ts:167`, `cli/watch-set.ts:48`, `index.ts:109`              | `buildPackageGraph(metas)`                                                                | `buildProjectGraph(projects, edges)`; public export dropped                                                                                 |
| `workspace/affected.ts:340-490`                                                                                                                  | manifest diff at base (removed package, `workspaces` change, version no longer satisfies) | deleted; the lockfile diff (`fingerprint.affected`) names those projects                                                                    |
| `workspace/affected.ts:495-535`                                                                                                                  | new nested project judged by `package.json#name` at base                                  | core: judged by a config file absent at base; vx-lockfile `affected`: a new importer also names its enclosing project                       |
| `packages/vx-migrate/src/nx/nx-map.ts:528`                                                                                                       | `buildPackageGraph`                                                                       | Nx graph's own dependencies                                                                                                                 |

**C. Key → vx-lockfile `project` + `key` + `fingerprint`**

| Where                                                                                                                         | What                                                                                                     | Goes to                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `orchestrator/task-hash.ts:26-52, 164-176, 223, 349-364, 469-510`; `cache/key-fold.ts:157, 165`; `cache/layer.ts:81-88`       | `pkg:` part, memo, input fact                                                                            | deleted; plugin adds `package.json` to `cache.inputs.files`            |
| `exec/executor.ts:76-77`; `packages/vx-reapi/src/executor.ts:809-811`                                                         | `packageJsonDigest` in the input root                                                                    | deleted; it is an ordinary input now                                   |
| `orchestrator/execute-task.ts:194, 1685-1687, 1767-1781`; `orchestrator/stable-keys.ts:61`; `orchestrator/prepare.ts:156-159` | package.json memo invalidation, output-may-not-cover rule                                                | generic input handling; output rule covers the config file only        |
| `workspace/fingerprint.ts:15-45`                                                                                              | `WORKSPACE_FINGERPRINT_FILES` (lockfiles, `pnpm-workspace.yaml`, `.yarnrc.yml`, `.npmrc`, `bunfig.toml`) | deleted; each vx-lockfile plugin claims its own                        |
| `orchestrator/sandbox-request.ts:801-815`                                                                                     | `mayWriteFingerprint`                                                                                    | over claimed files                                                     |
| `orchestrator/affected-tasks.ts:32`                                                                                           | `KEYED_BY_EVERY_TASK` holds `package.json`                                                               | config filenames only                                                  |
| `workspace/config-schema.ts:1164-1169`                                                                                        | outputs may not cover `package.json`                                                                     | config file only (the run-time input/output rule covers plugin inputs) |
| `cli/why.ts:46`                                                                                                               | `package` miss reason                                                                                    | deleted; shows as an input file                                        |

## Plugin API changes

```ts
discover?(ctx: DiscoverContext): readonly DiscoveredProject[] | Promise<…>

interface DiscoveredProject {
  readonly dir: string                 // absolute or root-relative
  readonly name?: string               // names it if its name is the path default
  readonly deps?: readonly string[]    // dirs: order + reach (^task, --filter ..., --affected)
  readonly reach?: readonly string[]   // dirs: reach only (--filter ..., --affected)
}
```

- A dir that is not yet a project becomes one (`configPath: null`, tasks
  `{}`), as today. A dir that is one: `name` replaces a path-default
  name; a config `name` wins silently (owner order); a different name
  from an earlier plugin is a `UserError`.
- `deps` / `reach` from all plugins union. A target that is not a project
  after the stage, or outside the root, is a `UserError` naming plugin.
  Any entry carrying `deps` makes the workspace an edge source (rule 4).
- `NamedProject` is replaced by `DiscoveredProject`.
- `ProjectMeta` and `ProjectHookContext` lose `packageJson`;
  `DiscoverContext.projects` carries core's lock-derived projects.
- `FingerprintClaim.files` no longer "takes a file out" (core folds
  none): a claim means `--affected` asks the claimant and `vx watch`
  re-runs on it. `WorkspaceFingerprints.unclaimed` and the workspace key
  part go.
- `vx lock` now runs `discover` (dependency rules and graph rules read
  edges; neither is written to the lock).
- Config: `defineProject({ name?: string, … })`.

## @vzn/vx-lockfile changes

- `discover`: one parse per lockfile content (the existing on-disk memo,
  extended with per-importer workspace deps and peers; `DIGEST_VERSION`
  bump). Returns every importer: `{ dir, name, deps, reach }`. `name` is
  the importer's `package.json#name`, given only when no other importer
  shares it (so core's duplicate refusal stays a config-level error).
  Edges: a dependency the lockfile resolves to a workspace importer
  (pnpm `link:`, bun / yarn berry `workspace:`, npm `link: true`). A
  workspace peer is `deps` unless it closes an order cycle, then `reach`
  (rule moved from `package-graph.ts`).
- `project`: appends literal `package.json` to every task's
  `cache.inputs.files` when the project has one.
- `fingerprint.files` / `key`: the lockfile (as today) plus the
  manager's install settings, folded whole into every task: pnpm
  `pnpm-workspace.yaml`, `.npmrc`; bun `bunfig.toml`, `.npmrc`; npm
  `.npmrc`; yarn `.yarnrc.yml`. `npm()` reads `npm-shrinkwrap.json` when
  present; `bun()` refuses a `bun.lockb` with no `bun.lock`.
- yarn classic records no workspaces: `yarn()` refuses a v1 lockfile
  (open question 2).

## Versions

- `CACHE_VERSION` stays `vx-cache-v43`. Every key changes (the `pkg:` and
  `workspace:` parts leave the chain; plugin inputs and names enter it),
  so no unchanged key can hold wrong bytes; the CLAUDE.md rule says no
  bump. `SCHEMA_VERSION` (`v35`)
  stays: no table changes.
- Lock `LOCKFILE_VERSION` 2 → 3:
  `{ version: 3, projects: { "<posix dir, '.' for root>": { file, config } } }`.
  Keyed by directory so a plugin's live name never invalidates the lock;
  `config.name` is recorded as written.
- vx-lockfile `DIGEST_VERSION` 14 → 15 (memo holds edges).

## Cost

- **A JS repo without the plugin can stale-hit**: no `^` edges (refused,
  rule 4) and, worse, no lockfile or `package.json` in any key. Every
  install-driven change replays old bytes. `vx init` and
  `@vzn/vx-migrate` add the plugin; nothing in core can warn without
  knowing JS. This is the price of the decision.
- ~230 core test files write `package.json` / `workspaces`
  (`tests/helpers/workspace.ts` is the shared scaffold). They move to
  config-only projects and an inline `edges()` test plugin
  (`tests/helpers/plugin.ts`). Most churn is mechanical; it is still the
  largest part of the work.
- vx-migrate `turbo()` / `nx()` read `package.json` themselves (scripts,
  memo keys at `turbo/index.ts:260`, `nx/index.ts:343`, `paths.ts:34`).
- Warm path: core stops one readdir + one manifest read per member; the
  plugin adds one `package.json` read per importer (pnpm, bun, npm,
  yarn alike). Expected neutral with the plugin, faster without; PRs 4
  and 5 carry an interleaved A/B (1,000 projects) or are not done.

## PR split (each leaves CI green; docs, features.md and site in the same PR)

1. `feat(plugin): discover names projects and supplies edges` —
   `DiscoveredProject`, union into the graph beside core's manifest
   edges (additive).
2. `feat(vx-lockfile): discover importers and edges from the lockfile` —
   `discover`, `project` (`package.json` input), settings claims. Parity
   row: plugin edges equal `buildPackageGraph` on every vx-lockfile and
   core package-graph fixture; each difference is listed in the PR as a
   lockfile-exact change.
3. `feat(graph)!: project edges come only from plugins` — delete manifest
   edges, catalogs, the manifest diff in `affected.ts`; rule 4; test
   scaffold gains `edges()`; nx-map, playground follow.
4. `feat(cache)!: core keys no package file` — section C; vx-reapi drops
   `packageJsonDigest`; A/B.
5. `feat(workspace)!: a project is a directory with a vx.config` —
   rules 1-3, `name`, lock v3, runs read dirs from the lock, `discover`
   in `vx lock`, `packageJson` gone from contexts, watch follows the lock;
   vx-migrate reads manifests itself; A/B.
6. `feat(cli)!: vx init writes no package.json-derived config` — scripts
   mapper and `findManifestRoot` to `@vzn/vx-migrate` (after question 1).

## Test plan (each red before its PR's change)

- PR 1: a plugin's `deps` orders `^build` with no manifest dependency;
  `reach` selects under `--filter lib...` but adds no order; a dep on a
  non-project and a conflicting rename are named refusals.
- PR 2: per manager, `discover` returns importers, names and edges from
  a lockfile whose manifests disagree (lockfile wins); an edited
  `package.json` re-keys its tasks and none elsewhere; an edited
  `.npmrc` / `bunfig.toml` / `pnpm-workspace.yaml` / `.yarnrc.yml`
  re-keys every task; the parity row; a tsdown-style task rewriting its
  own `package.json` identically still hits.
- PR 3: `^build` with no edge source fails naming the fix; with one, a
  leaf runs; a manifest dependency without the plugin adds no edge;
  `--affected` after a dependency add selects the dependent through the
  lockfile diff.
- PR 4: `task-hash-derive.test.ts`: no package part; a root `.npmrc` edit
  without a plugin moves no key; `vx why` names `package.json` as an
  input; vx-reapi input root still holds `package.json` via inputs.
- PR 5: a dir with only `vx.config.ts` is a project named by its path;
  root is `//`; `name` wins over the plugin's and the path; duplicate
  names fail naming both; a git-ignored config is not found; a config
  under a nested `.vx/workspace.ts` is not found; a config added after
  `vx lock` does not run; lock v2 is refused ("re-run `vx lock`"); a
  `pnpm-workspace.yaml` member with no config and no plugin is no
  project; `--affected` without a plugin: containment + task edges only.
- Every PR: `tests/read-once.unsafe.test.ts` / `syscall-repeats` stay
  green (`package.json` read once per run, by the plugin).

## Out of scope

- JS runtime conveniences in core: `node_modules/.bin` on PATH
  (`exec/env.ts:30`, `cache/inputs.ts:479-482`), `npm_execpath` from
  `package.json#packageManager` (`exec/env.ts:79-115`), sandbox grants
  for `node_modules` links (`orchestrator/sandbox-request.ts:215-227`),
  `node_modules` in ignore lists (open question 3).
- Plugins as npm packages: `definePlugin` naming by `package.json`
  (`orchestrator/plugin.ts:473-508`), the local hand-off
  (`handoff.ts:27`), `vx upgrade`, config import resolution
  (`workspace/config-imports.ts:76, 305`). The config language is TS.
- Locking names or edges: computed live (owner rejected locking the
  graph).
- Workspace discovery for other ecosystems (Cargo, Go): a plugin's job
  through the same `discover`.

## Owner calls (defaults until M overrides, 2026-10-14)

1. `vx init`'s package.json script mapper (and `findManifestRoot`) moves
   to `@vzn/vx-migrate`; core `vx init` writes only `.vx/workspace.ts`
   plus a starter config.
2. `yarn()` refuses a yarn classic (v1) lockfile: it records no
   workspaces, so its edges cannot come from the lockfile.
3. The runtime conveniences listed out of scope stay in core for now;
   moving them needs an env/PATH seam, a separate design.

## Why this is the right move

- Core's concepts become directory, config, name, edge, key: nothing
  that assumes a language.
- One seam (`discover`) carries membership, names and edges; no new
  stage, no special case.
- Edges from the lockfile are what was installed, not a guess from
  semver ranges and catalogs (~400 lines of `package-graph.ts` go).
- Runs read the lock instead of walking, so discovery gets cheaper.
- The rule for `^` without edges is an error, so dropping the plugin
  fails loud instead of replaying stale bytes.
