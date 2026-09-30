# @vzn/vx-migrate

Everything for adopting [`@vzn/vx`](https://github.com/vznjs/vx) from Turborepo, Nx, moon, wireit or lage, in one package with zero dependencies:

- **`turbo()`** — run a Turbo repository under vx with nothing written. The plugin fills vx's `project` stage from `turbo.json` and each package's `package.json` scripts. A trial that commits nothing.
- **`nx()`** — run an Nx repository under vx with nothing written: the same stage, filled from Nx's resolved project graph. Executor targets (`@nx/js:tsc`, `@nx/vite:build`, your own) run as themselves through **`nx-exec`**, one executor per process.
- **`moon()`** — run a [moon](https://moonrepo.dev) workspace under vx with nothing written, from `.moon/` and each `moon.yml`.
- **`wireit()`** — run a [wireit](https://github.com/google/wireit) workspace under vx with nothing written, from each `package.json`'s `wireit` block.
- **`lage()`** — run a [lage](https://microsoft.github.io/lage/) workspace under vx with nothing written, from `lage.config.js`.
- **`workspaceScripts()`** — run a workspace with no orchestrator, whose root scripts fan out (`pnpm -r run build`, `npm run test --workspaces`, `yarn workspaces foreach`, `lerna run`).
- **`bunx @vzn/vx-migrate`** — write one `vx.config.ts` per workspace package from your `turbo.json`, an exported Nx project graph, `.moon/`, `wireit` blocks or `lage.config.js`, plus the workspace file every run needs. Runs without a workspace file, so it is the first command, not the second.
- **`turboCache()`** and **`nxCache()`** — keep the remote cache you have: any server speaking Turbo's `/v8/artifacts` API (Vercel's hosted cache included) or Nx's self-hosted `/v1/cache` spec.

```sh
npm install -D @vzn/vx @vzn/vx-migrate   # or: pnpm add -D · yarn add -D · bun add -d
```

In a Turbo or Nx repo, `npx vx init` writes the `vx.workspace.ts` that
declares `turbo()` or `nx()` and prints the install-and-run line. Add
`turboCache()` or `nxCache()` to keep your remote cache:

```ts
// vx.workspace.ts — a Turbo repo, unchanged, with its remote cache
import { defineWorkspace } from '@vzn/vx'
import { turbo, turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turboCache(), turbo()] })
```

## `turbo()` — run a Turbo repo unchanged

Then `vx run build --all` runs every package's `build` script the way `turbo run build` would: `dependsOn` edges (`^build`, same-package deps, `pkg#task`), `inputs` / `outputs` as the cache block, `env` / `passThroughEnv`, `cache: false`, `persistent`. Turbo's global fields (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`, Turbo 1's `globalDotEnv`) are inlined into every task, a wildcard env name among them reported once and left out; per-package `turbo.json` overlays apply. A `turbo.jsonc` (Turbo 2.5+) is read wherever a `turbo.json` would be, at the root and in a package; a workspace root with neither is refused, naming the fix. Turbo 2's framework inference (a package on `next` has `NEXT_PUBLIC_*` hashed and passed; likewise `vite` → `VITE_*`, `react-scripts` → `REACT_APP_*`, `gatsby` → `GATSBY_*`, `astro` → `PUBLIC_*`) has no vx form, since vx env names are explicit: a note names each framework and the packages it applies to. What runs is what a migration would have written, minus the file: the key a task derives here equals the key the written config would derive.

| Option | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| `root` | Directory holding `turbo.json`. Defaults to the workspace root. |

### Locking

`vx lock` freezes the evaluation of written `vx.config.*` files only. A package that has none gets its tasks from `turbo.json` on every load — under `--frozen` too — so the lock records nothing for it and `vx lock --check` does not audit it; `turbo.json` is its source of truth, committed like one.

### What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from `turbo.json`.
- The mapping's gaps are the migration's gaps, reported as warnings on every run instead of `TODO(vx-migrate)` comments: `$TURBO_ROOT$` tasks, wildcard env names, unknown turbo keys. A persistent task's readiness note (`readyWhen`) is reported only when something depends on it — with no dependent there is nothing to gate (refine printed it for 375 `dev` targets a run). `bunx @vzn/vx-migrate --dry` lists the same set once. Each gap is one line per run for every task that carries it, not one per task (n8n marks `dev` and `watch` persistent in most of its 84 packages; astro negates `vendor/**` in the outputs of 57 tasks). A per-package `{ "extends": false }` with nothing else is Turbo's opt-out and maps to no task; with keys, the task runs on those keys alone. A glob that climbs out of the package (`../../packages/app-store/*.generated.ts`) is re-anchored on the workspace root as a `workspaceFiles` glob. A negated output under a literal-rooted one (`dist/**` minus `!dist/**/*.map`) is a todo and the positive glob stays; one against a wildcard-rooted output (medusa's `*/**` minus `!src/**`) makes the task uncached, because the clean before exec would otherwise delete the sources — declare the exact outputs in a vx.config to cache it.
- The cost is the stage's: on a 1,000-package workspace with no `vx.config` files the mapping loads in about 42 ms where 1,000 evaluated configs load in 22, in a run that is otherwise the same ~200 ms warm.
- The mapping is kept in `<cache dir>/vx-migrate-turbo-mapping.json`, keyed on every `turbo.json` / `turbo.jsonc`, every package manifest and the mapper's own code; a run with none changed reads it instead of mapping (astro, 562 packages: ~40 ms of mapping against ~12 ms of key reads).
- The mapping is read once per run, never once per process: under `vx watch`, a `package.json` script edit or a per-package `turbo.json` overlay edit is the next cycle's tasks. The root `turbo.json` is no task's input and lives in no project dir, so an edit to it is not a cycle — restart the watch.

### The mapper (`mapTurboWorkspace`)

The plugin and the CLI read a repo the same way: the mapper the plugin runs live is what `bunx @vzn/vx-migrate` writes `vx.config.ts` per package from, splicing Turbo's global fields in as imports of a generated `vx-preset.ts`, where the plugin inlines the values. `splice` is the seam between the two consumers; `uses` names which globals a task drew on. Before 2026-09-10 the mapper lived in `@vzn/vx` itself; until 2026-09-11 the plugin was its own package, `@vzn/vx-turbo`.

Rules:

- **A task exists for a package only when the package declares the script** — Turbo's own rule. An absent script is silent; a script key whose value cannot be a command (a number, `null`, an empty string, an array) produces a `task: null` entry whose todo says why, rather than a config that fails to load.
- **Definition order**: root `pkg#name` if there is one, else root `name` (the first replaces the second whole, as Turbo looks it up), then each package config its own `turbo.json` extends (`"extends": ["//", "shared"]`, read by Turbo 2.11, refused by 2.5; nearest last, a parent missing or a cycle refused as Turbo refuses it) and its own, each winning field by field, except an overlay array holding `$TURBO_EXTENDS$` (Turbo 2.5+), which is the inherited list plus the overlay's other entries (`inputs: ["$TURBO_EXTENDS$", "config.json"]`).
- **The command is the script body** with its `pre<name>` / `post<name>` hooks folded in, in that order, through core's `foldScriptHooks`: each part in its own subshell, the chain stopping at the first that fails, forwarded `--` args reaching the body alone (npm and pnpm run them around `<name>` without being asked; novu's `prebuild` copies the CSS its `build` inlines), one process less per task than `pnpm run <name>` — except a body that calls yarn's `run` builtin (`run -T rollup -c`, `run clean && run build`; yarn ≥ 2 runs scripts in its own shell), which is `run: command not found` in sh: it runs as `yarn run <name>`, as Turbo and Nx run it, and yarn ≥ 2 runs no hooks, so none are folded there. A Yarn Plug'n'Play workspace (`.yarnrc.yml` with no `nodeLinker`, or `pnp`) has no `node_modules`: a dependency resolves only through `.pnp.cjs` and a bin only through yarn's shims, so there every script runs as `yarn run <name>`. Same rules for `nx:run-script` below (strapi and novu, 2026-09-11).
- **Turbo 2.11's task `command`** (`futureFlags.experimentalTaskCommand`) wins over the script, as Turbo holds it: an argv is the command — each word quoted, run from the package dir, no `pre`/`post` hooks — and gives the package the task even with no script (turborepo's `@turbo/types#build`, `docs#schema`); `null` or `[]` is Turbo's no-op node, no task even where the script exists, its edges passed through; a per-toolchain map applies its `javascript` entry (or `typescript`, Turbo's alias), and without one the script runs. A shape Turbo would refuse keeps the script, with a todo.
- `dependsOn`: `^x` passes through when some package runs `x`, and is dropped when none does (Turbo gives it no edges; core refuses a `^x` no project declares as a typo); `pkg#task` is kept only when `pkg` emits `task` (else a todo: edge dropped); a same-package task Turbo defines but the package has no script for is Turbo's no-op node, so its own edges pass through in its place (`test → codegen → ^build` with no `codegen` script is `test → ^build`); another package's `^x` or `pkg#x` reaches such a node through a group task when its edges name a task of its own package or another (with-tailwind's `ui` has no `build` script; its `build` builds `build:styles` and `build:components`, and `web#build` waits on them), while one with only `^` edges needs none, since core's `^x` walks past a package without `x`; a name Turbo does not define has no edge; `$TURBO_ROOT$` deps are a todo. Root `//#task`s run in the workspace root, as under Turbo: `turbo()` names the root a project through core's `discover` stage when turbo.json declares one (no `vx.config` needed; a root no member glob lists), and `//#x` in `dependsOn` is an edge to it, named by the root `package.json` `name`; a root task's globs are the workspace's (`workspaceFiles`), since Turbo hashes a root task over the whole repo; with no root project (a root `package.json` with no `name`, or one a package holds) they are a note and such an edge a todo. Turbo runs no plain task in the root package of a monorepo, and neither does `turbo()`; in a single-package repo (no workspaces, Turbo's `non-monorepo` example) turbo.json's plain tasks run on the root package, as under Turbo.
- A transit node (Turbo's documented pattern, its with-vitest example: `transit: { dependsOn: ["^transit"] }` with no script anywhere, and `test: { dependsOn: ["transit"] }`) is a key-only task in each package that defines it: it runs `true`, cached and keyed on its inputs, with its `^transit` edge, so a dependant's `test` re-keys on its dependencies' sources as Turbo re-hashes it. A `^` task that some package has a script for, or that nothing depends on, is no transit node.
- `with` (tasks Turbo runs alongside, `web#dev` with `api#dev`): an edge to each sidecar that is persistent, so vx starts the task once the sidecar has spawned and runs the sidecar only when the task runs; a sidecar that ends would be waited for, so it is a todo instead, and a pair that names each other keeps one edge (two would be a cycle). A task with no script whose `with` names persistent sidecars (Turbo's with-tailwind example: `ui` has no `dev` script, its `dev` starts `dev:styles` and `dev:components`) is a group task that depends on them.
- `inputs`: a structured entry (Turbo 2.11) is its `globs`, plus `**/*` with `withDefaults`, for `startup` and `jit` alike; `dependencyOutputs` adds none (vx folds each dependency's key). Then: absent or `[]` → `**/*` (Turbo's default); `$TURBO_DEFAULT$` → `**/*`; exclusions alone narrow `**/*`; `$TURBO_ROOT$/<path>` → `cache.inputs.workspaceFiles` (negation kept); any other `$TURBO_ROOT$` use is a todo. `globalDependencies` and Turbo 1's `globalDotEnv` land in `workspaceFiles` too, and a task's Turbo 1 `dotEnv` in its `files`. Turbo 1's `$NAME` entries, in `globalDependencies` or a task's `dependsOn`, are env vars: they join `cache.inputs.env` and `exec.env.passThrough`. Turbo's glob grammar is translated as Nx's is (`*.[jt]s` is `*.{[jt],j,t}s`); an input with no safe form widens to `**/*` with a todo. A `.env`-shaped input (`.env*`, `.env.local`, a task's Turbo 1 `dotEnv`, create-turbo's `globalDependencies: ["**/.env.*local"]`) is gitignored as a rule, so it is keyed by a probe that hashes every `.env` file under the package (`cache.inputs.runtime`) or, for a root entry, the workspace (`workspaceRuntime`), rather than as a file glob git never reports.
- `outputs`: `$TURBO_ROOT$/<path>` → `cache.outputs.workspaceFiles`; a negated output rides beside its positives and takes its paths back from the clean, the save and the restore (Next's `.next/**` minus `!.next/cache/**` keeps the cache), and one with no positive beside it takes back nothing and is dropped. Past its first segment an output takes Turbo's grammar (`dist/**/*.[cm]js`); the first stays a literal (a route directory). An output whose first segment is a wildcard (`**/*.d.ts`, `*.tsbuildinfo`) runs the task uncached with a todo: Turbo never cleans an output, vx cleans it before every run, and such a glob reaches the sources. An output that covers the package's own `package.json` (trpc's client build lists it: the build rewrites `exports`) runs the task uncached with a todo, in `nx()` too: vx would delete the manifest before every run, and core refuses that config. A committed file under an output (typescript-eslint's `data/sponsors.json` in a cached `data`) is taken back with `!` — Turbo, Nx and lage never clean an output, vx does — so it survives the clean and the task keeps its cache; past sixteen such files the task runs uncached with a todo. `turbo()`, `nx()` and `lage()` do this; `wireit()` does not, since wireit cleans outputs itself.
- `env` / `passThroughEnv`: explicit names go to `cache.inputs.env` (env only) and `exec.env.passThrough` (both, plus both globals); a wildcard is a todo. A name both a global list and the task's own list carry is listed once.
- **Two tasks of one package on one output path** (strapi's `build`, `build:code` and `build:types`, all on `dist/**`): vx cleans a task's outputs before it runs and before a restore, so the loader refuses two cached tasks whose outputs provably overlap. The mapping resolves it before the file is written — the task with a `^` edge keeps its cache (the first declared when none has one); a task a same-project edge orders after it stays cached too (vx caches what an ordered dependant ADDS to the tree — twenty's `build:individual` into `build`'s `dist`); the rest run uncached with a todo naming the keeper and the fix, their own output path or that edge. Same rule for Nx targets.
- **Two packages' tasks on one workspace output** (cal.com's shared `post-install` writes `../../node_modules/@prisma/client/**` from every package with the script): core refuses two cached tasks on one path with no edge between them, so `turbo()` (and `nx()` and `moon()`) keeps the first (in package and task order) cached and runs the rest uncached, each with a todo naming the keeper. A package's own outputs count at their workspace path: typescript-eslint's root project caches `dist` and each package's typecheck `dist/packages/<name>`, one path twice. Edges across packages are not read, so an ordered pair loses its cache too.
- `cache: false` or `persistent: true` → no `cache` block; a persistent task gets `exec.persistent: {}` and, when some task depends on it, the consumer's `persistentTodo`.
- A task's `description` (Turbo 2.11.5's schema) is the vx task's `description`.
- `outputLogs: "new-only"` maps to nothing: frames for the tasks that ran and a one-liner per cache hit is vx's default flow already. The other values are per-run in vx, so they are a todo naming the flag (`vx run … --output-logs hash-only`).
- `envMode: "loose"` (top-level or in `global`) is a note: Turbo hands every task the whole environment, vx only the declared names.
- The workspace keys vx has a home for, top level or in `global`, fill what `vx.workspace.ts` leaves unset: `concurrency` (`"10"`, `"50%"` of the cores) → `concurrency`; `cacheMaxSize` / `cacheMaxAge` (`"0"` is off; weeks become days, a bare number days; a size in Turbo's grammar, `7.5GB` or bare bytes, restated whole: `7680MB`) → `cacheRetention.maxSize` / `.olderThan`.
- Turbo 2.11's `global` block (`futureFlags.globalConfiguration`) is read as the `globalDependencies`, `globalEnv` and `globalPassThroughEnv` it replaces.
- An unknown Turbo key is a todo naming it; `extends` is accepted and ignored (the overlay order above is what it means).

## `nx()` — run an Nx repo unchanged

```ts
// vx.workspace.ts — an Nx repo, unchanged
import { defineWorkspace } from '@vzn/vx'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
```

Then `vx run build --all` runs every project's `build` target the way `nx run-many -t build` would. The plugin reads Nx's **resolved** project graph — where Nx has already applied `targetDefaults`, expanded `namedInputs`, inferred targets through its plugins and interpolated `{projectRoot}` and friends — so nothing is re-derived here. Per target: `nx:run-commands` and a plain `command` run as one shell line that does what Nx's run-commands does (below); `nx:run-script` is the package script; `nx:noop` is a group task; **every other executor runs through `nx-exec`** with the executor and its options on the command line. A target Nx caches (`cache: true`, or the legacy `cacheableOperations` list in `nx.json`) gets its `inputs` / `outputs` as the cache block, with no `inputs` meaning Nx's `default` and `^default`, named inputs resolved per project (nx.json's under the project's own), `{workspaceRoot}` / `{projectRoot}` / `{projectName}` interpolated anywhere in a path as Nx does (`{workspaceRoot}/coverage/{projectRoot}`), Nx's glob grammar translated (`*.[jt]s` is `*.{j,t}s`; the default `production` negation `?(*.)+(spec|test).[jt]s?(x)` becomes brace sets, a narrowing only a negation may take; what has no safe form is a todo), and an output outside the project dir (`dist/<project>` at the workspace root, Nx's default layout) a `workspaceFiles` output, an output whose first segment is a wildcard (typescript-eslint's `{projectRoot}/**/*.shot`, its committed snapshots) a todo and an uncached task, as in `turbo()`; `dependsOn` becomes the edges (`^build` — dropped when no project has the target, as Nx gives it no edges and core refuses a `^name` nothing declares — `build`, `project:target` → `project#target`, `project:target:configuration` → that configuration's task, `{ target, projects }` → each matched project's task, `projects` read as Nx reads it: a name or a list of names, `*` patterns, `tag:` patterns and `!` exclusions; an edge to a target its project lacks is dropped without a word, as Nx drops it — `targetDefaults` that give every `typecheck` a `codegen` one project has; `^name` is every dependency's `name` whatever it holds, `^rsbuild:typecheck` included; a target glob — `test:e2e--*`, `^build-*`, `ui:build-{esm,cjs}`, a `{ target }` object's — expands over every target name in the workspace, as Nx 19.5+ does, before those rules; a same-project glob keeps its own project's matches), `{ env }` inputs pass through, `{ runtime }` inputs run at the workspace root as Nx runs them (`cache.inputs.workspaceRuntime`), a target that says `continuous` — or, in a graph from an Nx older than that field, runs a server executor (`@nx/vite:dev-server`, `@nx/next:server`, …) — is a persistent task and never cached, with the `readyWhen` note only when something depends on it. The target's name never decides: a cached `dev` caches like any other target (nx#32610). `parallelism: false` (Nx runs the target alone) and `syncGenerators` (Nx runs them first) have no vx form and are todos: `--concurrency 1`, and `nx sync`; nx.json's `sync.globalGenerators` is one note per run naming `nx sync`. A target with `configurations` is one task per configuration: `build` carries the default configuration's options, `build:ci` the `ci` one. A `^name` input (`^production`, `{ input, dependencies: true }`) is what Nx hashes: each dependency's `name`, over the project graph, whether or not a task edge exists. Each project some reader reaches gets an `nx-input:<name>` task — `true`, cached, keyed on its own `name` input, depending on its Nx dependencies' twins (a project nothing reaches gets none) — and a task that reads `^name` depends on its direct dependencies' twins, so the whole closure folds into its key with each project hashed once. A dependency FILESET (`^{projectRoot}/tsconfig.lib.json`, `{ fileset, dependencies: true }`, which Nx's own inferred `typecheck` writes) folds the same way: its twin, `nx-input:fileset-<hash>` (a glob's `*` is no task name; the task's description names the fileset), keys on that fileset in each project. The twins show in a run's output; each costs about 0.16 ms of a warm run. A path input inside an output one of the project's own targets declares (TanStack/table's `public` input lists `{projectRoot}/dist`) is generated: git does not list it, so vx cannot key on it, and it is dropped with a todo; the task that writes it keys its dependants through `dependsOn`.

| Option  | Meaning                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `root`  | Directory holding `nx.json`. Defaults to the workspace root.                                                                                                 |
| `graph` | An exported graph (`nx graph --file=<path>`) to read instead of keeping a snapshot; with it set the plugin never runs `nx`. Relative to `root`, or absolute. |

### `nx:run-commands`

Nx's own option handling, rendered as one POSIX `sh` line (`vx show` prints it):

- **Where:** the workspace root unless `cwd` says otherwise — a `cd` from the project dir, since vx has no per-task cwd — with `{projectRoot}`, `{projectName}` and `{workspaceRoot}` expanded.
- **How:** each command runs in a shell of its own. `commands` run in **parallel** unless `parallel: false` (Nx's default): all start at once, the first failure TERMs the rest and fails the task once they have exited (exit 1, as Nx), and the task succeeds once every command has (nx#28477). With `parallel: false` they run in order and the first failure stops the rest. `commands: []` is a no-op that succeeds (nx#31345).
- **Arguments:** every option run-commands does not consume is appended to each command as `--name=value`, then `args`, then whatever follows `vx run … --` — per command unless `forwardAllArgs` is false (nx#12165). `{args}` takes them in place; `{args.name}` is filled from the target's options and `args` — a value passed after `--` does not reach it (a todo).
- **Environment:** `env` is `exec.env.define` (so it is in the key), and `color: true` sets `FORCE_COLOR=true`, as Nx does (nx#20465). `envFile` is loaded after the task's `.env` files (below), a name they already set winning, as in Nx (nx#23581).
- **`readyWhen`** makes the task persistent with that string as its `readyWhen`, so dependents start once it is printed; several strings, all of which Nx waits for, are one pattern here that matches the first (a todo).
- **Reported, not reproduced:** per-command `prefix` / `color` decoration, `streamOutput: false`. Display-only options (`usePty`, `tty`, `verbose`) change nothing here: vx runs every task without a pseudo-terminal.

`tests/nx-exec-live.test.ts` holds each of these shapes to Nx's own run-commands executor on the same options and arguments.

### `.env` files

Nx loads a task's `.env` files into its environment — the project's before the workspace root's, the most specific name first (`.env.build.production.local`, `.env.build.production`, …, `.env.local`, `.local.env`, `.env`), the first to define a name winning and the environment winning over every file — unless `NX_LOAD_DOT_ENV_FILES=false`. `nx()` finds the ones that exist from one listing of each project dir per run (about 4 ms at 1,000 projects) and the task loads them when it runs, with Nx's own parser: a shell line runs under `nx-env --dotenv <file>… --`, an executor line passes `--dotenv <file>` to `nx-exec`. Their values never enter a config, so a `.env.local` secret is not in `vx show`, `vx-lock.json` or a migrated `vx.config.ts`. A cached task keys on their bytes through a `cache.inputs.runtime` probe (`for f in …; do echo "$f"; cat -- "$f"; …`), which sees a gitignored file a glob would not; a file added or removed changes the command, and so the key, on the next run. `tests/nx-exec-live.test.ts` compares what the line sees with what `nx run` gives the same target.

### nx.json `parallel`

`parallel` (or the legacy `tasksRunnerOptions.default.options.parallel`) is the run's `concurrency` when `vx.workspace.ts` sets none: a repo that set `1` for a shared resource ran on every core under vx before.

### The graph snapshot

Once per run the plugin keys its snapshot (`<cache dir>/nx-project-graph.json`) on what Nx computes the graph from: `nx.json` and the files its `extends` chain names by content, and the worktree as git sees it — `HEAD`, `git status -uall`, and the content of every listed path under a project root (the last graph's too, so a project `discover` names counts before it is one), any `project.json`, or at the root (manifests, lockfiles, `tsconfig*.json`). A different key, or no snapshot, runs `node_modules/.bin/nx graph --file=<snapshot>` — the one time Nx itself runs, served from the daemon when one is up. So a source edit that adds a cross-package `import` (an edge Nx derives) or a config an Nx plugin infers targets from (`vite.config.ts`) re-exports before the run, tracked or untracked, and a touch without an edit, or a stray file a task writes at the root, does not. Outside a git worktree the plugin falls back to the manifests' mtimes. The snapshot and its key live in the cache dir, which ignores itself (a `*` `.gitignore` inside it), so writing them moves nothing. Nx's own caches (`.nx/cache/`, `.nx/workspace-data/`, which the export writes) never enter the key: under a root project (a standalone repo) that does not ignore them, each export re-exported on the next run. An export that fails with a snapshot in hand warns and runs on the previous graph. The snapshot is machine-local, like the cache: nothing about it enters a key. Measured at 1,000 projects: the export runs once (1.5 s with the daemon off after an edit, 0.9 s with it on; Nx's own computation), and a warm run with nothing changed pays the key, 43 ms at min where the manifest stats it replaced took 9 (item 1075), plus the mapping. Under `vx watch` the same rule runs per cycle: a `project.json` edit is the next cycle's tasks, the export included — 1.3 s from the edit to the new command's effect on that workspace. The mapping itself is kept beside it (`<cache dir>/vx-migrate-nx-mapping.json`), keyed on everything it reads — the graph, `nx.json` and its `extends` chain, every package manifest, each project dir's `.env` names, `NX_LOAD_DOT_ENV_FILES`, which bins are installed and the mapper's own code — so a warm run with nothing changed maps nothing (refine, 206 projects: median 284 → 243 ms).

### What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from the graph.
- An Nx project no workspace package matches — the root project, or an integrated repo's `project.json` library no package glob lists (analogjs) — is made a project through core's `discover` stage, by its `package.json` name or else its Nx name, and its targets attach there by directory; no `vx.config` is needed. One whose name a package already holds, or whose directory is gone, has nowhere to go and is reported once per run; run its targets with `nx`. A `^target` only such a project declares is no edge, as under Nx, and an explicit edge to one of its targets is dropped with a todo (the key misses it) rather than refusing the run. A negated output (`!{projectRoot}/dist/cache`) takes its path back from the positive ones (core's A-44). A cached target with no `outputs` takes what Nx caches for it: `options.outputPath`, or for `build` and `prepare` `dist/{projectRoot}` and `{projectRoot}/dist`; Nx's `{projectRoot}/build` and `{projectRoot}/public` are a todo, since vx cleans an output before the run and those often hold committed files.
- Nx adds an `nx-release-publish` target (`@nx/js:release-publish`) to every project with a `package.json`; it comes along as one `nx-exec` task per package, run only when asked (`vx run nx-release-publish --filter <pkg>`), and counts in `vx info`'s task total.
- `nx-exec` and `nx-env` must be on every task's PATH, which they are when `@vzn/vx-migrate` is a devDependency of the workspace (its bins land in `node_modules/.bin`); a plugin loaded by path warns once per run when they are not. Both load Nx from the workspace, so a repo run from an exported `graph` with no `node_modules/nx` warns once too.
- Nx's configuration propagation (`nx run app:build:production` builds dependencies with `production` where they declare it): a `build:production` task's `^build` edges run the dependencies' default configuration, with a warning naming it.
- Batch executors run one task per process; an executor that reads `context.taskGraph` under `NX_BUILDABLE_LIBRARIES_TASK_GRAPH` sees none and takes Nx's project-graph path.
- The mapping's gaps are the migration's gaps, reported as warnings once per run for all the tasks that carry each one. `bunx @vzn/vx-migrate --dry --from nx` lists the same set once.

## `moon()` — run a moon workspace unchanged

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { moon } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [moon()] })
```

Then `vx run build --all` runs each project's moon `build`. Read: `.moon/workspace.yml` (`projects` as a map, globs, or `{ globs, sources }`), the inherited task files (`.moon/tasks.yml`, `.moon/tasks/**`) and each project's `moon.yml`. A task file is inherited as moon 1 inherits it, by name (`node.yml`, `typescript-library.yml`, `tag-<t>.yml`), or, in a moon 2 workspace (one with `.moon/toolchains.yml` or an `inheritedBy` block), by `inheritedBy` (`toolchains`, `languages`, `layers`, `stacks`, `tags`; a list is any, `{ and, or, not }` as moon reads it; `order`); a condition it does not know keeps the file out, with a note. The language is `moon.yml`'s, else `typescript` where a `tsconfig.json` sits, else `javascript`.

| moon                                                                                                                                  | vx                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` + `args`, `script`                                                                                                          | `exec.command`: a list's words are quoted, a string is kept as written                                                                      |
| layers of one task                                                                                                                    | merged field by field; `args`, `deps`, `env`, `inputs`, `outputs` by the task's final `options.merge*`                                      |
| `workspace.inheritedTasks` `include` / `exclude` / `rename`                                                                           | applied to the inherited tasks                                                                                                              |
| `extends`                                                                                                                             | the named task with this one's fields merged on                                                                                             |
| `deps`: `build`, `~:build`, `^:build`, `app:build`                                                                                    | `dependsOn`: `build`, `^build`, `app-package#build`                                                                                         |
| `moon.yml` `dependsOn` a package.json does not name                                                                                   | `^:task` becomes an explicit `pkg#task` edge to it                                                                                          |
| `implicitDeps` / `implicitInputs`                                                                                                     | joined to every task                                                                                                                        |
| no `inputs`                                                                                                                           | `cache.inputs.files: ['**/*']`, moon's default                                                                                              |
| `@group` / `@globs` / `@files` / `@dirs`                                                                                              | the file group's entries                                                                                                                    |
| `/path`, `$workspaceRoot/path`                                                                                                        | `cache.inputs.workspaceFiles` / `outputs.workspaceFiles`                                                                                    |
| `$VAR` input                                                                                                                          | `cache.inputs.env` **and** `exec.env.passThrough`                                                                                           |
| a `.env` input, `options.envFile`                                                                                                     | `cache.inputs.runtime`: a probe of every `.env` file's name and bytes (git ignores them)                                                    |
| `env`                                                                                                                                 | `exec.env.define`                                                                                                                           |
| `@in(n)`, `@out(n)`, `$project`, `$task`, `$target`, `$workspaceRoot`, `$projectRoot`, `$projectSource`                               | expanded in the command                                                                                                                     |
| `options.cache: false`                                                                                                                | no `cache` block                                                                                                                            |
| `options.persistent`, `local: true` (moon 1, and by default for a task named `dev`, `start` or `serve`), `preset: server` / `watcher` | `exec.persistent: {}`, uncached                                                                                                             |
| `node.inferTasksFromScripts` (moon 1)                                                                                                 | each script a task running `<packageManager> run <script>` (`:` becomes `-` in its name), under the `moon.yml` declaration of the same name |
| `options.runFromWorkspaceRoot`                                                                                                        | `cd <root> && …`                                                                                                                            |
| `options.retryCount` / `timeout` (seconds)                                                                                            | `exec.retries` / `exec.timeout` (ms)                                                                                                        |
| `command: noop`                                                                                                                       | a group task: `dependsOn` only                                                                                                              |

Not mapped, each a TODO or a note: a project that is not a package-manager workspace package (vx discovers projects from `package.json` workspaces), a tag target (`#tag:task`) or an all-projects dep (`:task`), a token with no vx form (`@meta`, `@envs`; the task is skipped and an edge to it dropped), and `options.affectedFiles`, `interactive`, `mutex`, `os`. moon passes a task the whole environment and vx an isolated one: list what a task reads as a `$VAR` input. A `remote.host` in `.moon/workspace.yml` is a Bazel REAPI server; [`@vzn/vx-reapi`](../vx-reapi)'s `reapi()` stores vx's artifacts there, and a note says so. Every value here was checked against `moon query tasks` (1.41.7 on moonrepo/examples, adobe/leonardo, jsx-email and astro-shield; 2.5.5 on a moon 2 fixture).

## `wireit()` — run a wireit workspace unchanged

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { wireit } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [wireit()] })
```

Then `vx run build --all` runs each package's `wireit.build`, read from its `package.json`.

| wireit (`package.json` `wireit.<script>`)  | vx                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `command`                                  | `exec.command`; none is a group task (`dependsOn` only)                                |
| `dependencies`: `build`, `../pkg:build`    | `dependsOn`: `build`, `pkg-name#build`                                                 |
| a dependency that is a plain npm script    | a task running that script (its `pre`/`post` hooks folded in), uncached                |
| `files` **and** `output` both set          | `cache.inputs.files` / `cache.outputs.files`; either missing, no cache (wireit's rule) |
| a `../` file                               | `cache.inputs.workspaceFiles`                                                          |
| `env`: `"value"` / `{ external: true }`    | `exec.env.define` / `cache.inputs.env` **and** `exec.env.passThrough`                  |
| `service`, `service.readyWhen.lineMatches` | `exec.persistent`, `exec.persistent.readyWhen`                                         |
| `clean`                                    | nothing: vx cleans outputs before every run, as wireit's default does                  |

Not mapped, each a TODO or a note: a dependency on a directory that is not a workspace package, a task with `clean: false` (vx cleans outputs before every run, and such an output may be a source; the task runs uncached), `cascade: false` (vx folds every dependency's key), an external env `default`, and `allowUsuallyExcludedPaths`. On lit/lit (53 packages) all 299 mapped tasks load.

## `lage()` — run a lage workspace unchanged

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { lage } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [lage()] })
```

Then `vx run build --all` runs what `lage build` ran. The config (`lage.config.js`, `.cjs` or `.mjs`) is code: it is evaluated in a child `bun` once per run, and the mapping is keyed on the result, so an edit to a file it requires remaps.

| lage (`pipeline`)                                | vx                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `task` (npmScript), `options.script`, `taskArgs` | `exec.command`: the package's script (hooks folded); no script, a pass-through                       |
| `task: [...]`                                    | `dependsOn`                                                                                          |
| `pkg#task`                                       | replaces `task` for `pkg` (`enableTargetConfigMerging` deep-merges instead)                          |
| `dependsOn`: `build`, `^build`, `pkg#build`      | the same                                                                                             |
| `^^build`                                        | a `pkg#build` edge to every transitive dependency that has it                                        |
| `type: 'noop'`                                   | a group task                                                                                         |
| `type: 'worker'`, `options.worker`               | a **`lage-worker`** line: the module and its options, one process                                    |
| `inputs` (none: every package file)              | `cache.inputs.files`                                                                                 |
| `outputs`, else `cacheOptions.outputGlob`        | `cache.outputs.files`; neither: no cache (lage would cache every package file, which vx would clean) |
| `environmentGlob` (target or `cacheOptions`)     | `cache.inputs.workspaceFiles` (a leading `/` is the root)                                            |
| `cache: false`                                   | no `cache` block                                                                                     |

Not mapped, each a TODO or a note: custom runner types (the task is skipped and an edge to it dropped), a worker whose options hold a function, root targets (`#task`, `//#task`, `<root package>#task`), a `shouldRun` function, and `weight` / `priority` / `stagedTarget`. On fluentui-react-native (85 packages) all 498 targets plan, and on lage's own repo all 196.

### `lage-worker` — one worker, one process

lage runs a `type: 'worker'` target by importing its module into a worker thread and calling the exported function (`run`, the default export, or the module) with `{ target, weight, taskArgs, abortSignal }`. `lage-worker` does the same in a process of its own, with the module path relative to the package and the options on the command line, so vx's key sees them:

```bash
lage-worker ../../scripts/worker/transpile.js --package @lage-run/cli --task transpile --options '{"flavor":"strict"}'
```

It is a Node bin (workers are Node programs: swc's binding, jest's pool). A module `shouldRun` export that returns false skips the target; a first SIGINT or SIGTERM aborts the worker's `abortSignal`, a second ends the process. Keep `@vzn/vx-migrate` installed while a config runs one.

## `workspaceScripts()` — a workspace with no orchestrator

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { workspaceScripts } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [workspaceScripts()] })
```

For a repo whose root `package.json` scripts fan one script out through the package manager. Each fan-out becomes a task in every package it selects (the package's script, its `pre`/`post` hooks folded), uncached:

| Root script                                                                    | vx                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `pnpm -r [run] build`, `pnpm --filter <sel> build`                             | `build` in each selected package, `dependsOn: ['^build']` (pnpm sorts by the graph)            |
| `--filter ./packages/*`, `@scope/*`, `!name`, `name...`, `...name`             | the same selection: a path glob, a name glob, an exclusion, with dependencies, with dependents |
| `--parallel`, `--no-sort`                                                      | no `^` edge                                                                                    |
| `pnpm -C <dir> build`, `npm -C <dir> run build`, `yarn workspace <name> build` | `build` in that one package                                                                    |
| `npm run build --workspaces`, `--workspace <name or path>`                     | `^build` (npm runs in declaration order; the graph's order holds for any declaration)          |
| `yarn workspaces run build`, `yarn workspaces foreach [-t] [-p] run build`     | `^build`, none under `-p` without `-t`                                                         |
| `bun --filter <sel> build`                                                     | `^build`                                                                                       |
| `[pnpm \| yarn \| npx] lerna run build [--scope] [--ignore] [--parallel]`      | as pnpm                                                                                        |
| `a && b` in one root script                                                    | `b`'s task depends on `a`'s in the same package (every `a` runs before any `b`)                |
| `dev`, `start`, `serve`, `watch`, `preview`                                    | `exec.persistent`                                                                              |

A package takes a task when any root script fans it out to it: `build` and `build:examples` over different packages are one `build`. Each root script that is not simply `vx run <name> --all` is reported once as the command that runs the same packages, its selectors as `--filter` (`` `build:examples` is `vx run build --filter '@example/*'` ``, `` `ci` is `vx run build test --all` ``); a filtered run also runs the builds its packages wait on; a root command that is not a fan-out (`tsc -p scripts && pnpm -r typecheck`) runs at the root, which vx has no task for, and is reported. A `[ref]` selector (changed since a git ref) selects every package. Checked against `pnpm -r` 10.34 at concurrency 1 on pinia, starlight and react-day-picker: the same packages, and pnpm's order breaks no vx edge.

## `nx-exec` — one Nx executor, one process

```
nx-exec <executor> --project <name> --target <name> [--configuration <name>] [--options '<json>'] [--dotenv <file>]... [overrides…]
nx-env [--dotenv <file>]... [--envFile <file>] -- <command> [args…]
```

`nx-exec` is a bin this package installs, and what `nx()` and the migrator write for every executor target. It runs under the workspace's Node (executors are Node programs), resolves `nx` from the working directory up to the workspace's `node_modules`, reads Nx's cached project graph for the `ExecutorContext` executors expect (project root, dependencies for buildable libraries; computed in-process when the cache is missing, never through the daemon), **replaces** that project's target in the in-memory graph with the executor and options given, and calls Nx's own public `runExecutor`, so Nx's option merging, schema defaults and validation run unchanged. Anything else on the line — what `vx run <target> -- --otp=123` appends — is an override, parsed by Nx's own `createOverrides` and handed to the executor as `nx run <p>:<t> --otp=123` would (nx#12165). `--dotenv` files are loaded into its environment first (see `.env` files above). The exit code is the last result's, as `nx run` reports it; a server executor keeps the process alive for as long as it yields. The bin enables Node's on-disk compile cache for its own process (Node ≥ 22.1, a no-op below), which takes about 30 ms off every executed task after the first.

`nx-env` loads the `.env` files and a run-commands `envFile` with Nx's own functions, then runs the command with `sh -c`, whatever follows it appended as vx appends forwarded arguments; its exit is the shell's.

Why the command carries the options: vx's key sees them (resolved-config hashing holds), no ambient state decides what runs, `vx show` prints the truth and the line pastes into a shell. Measured against `nx run <p>:<t> --skip-nx-cache --exclude-task-dependencies` on the same workspace: about 400 ms less per executed task at 200 projects and 830 ms at 1,000 with the daemon off (the only mode a sandbox allows), and still ahead of a warm daemon; the remaining ~220 ms floor is Nx's own module graph, paid on a miss only. The numbers and the design are in `docs/design/nx-unchanged-2026-09.md`.

## `bunx @vzn/vx-migrate` — write the configs

```bash
bunx @vzn/vx-migrate           # auto-detect: turbo.json, .nx/workspace-data/project-graph.json or .moon/workspace.yml
bunx @vzn/vx-migrate --dry     # print the generated files + the report instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
bunx @vzn/vx-migrate --help    # the usage, exit 0
```

`--dry` prints the files instead of writing them; `--force` overwrites existing ones; `--mjs` writes `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts` — the same objects with no type import and no `satisfies`, for a package whose own `tsconfig` includes every `.ts` under it and would compile the config into its dist (TanStack/query, 2026-09-11).

`package.json` scripts are core's own `vx init`. What this package writes reads exactly like what `vx init` writes: both hand a plan to core's migration seam (`applyMigration` from `@vzn/vx`), which renders, refuses to overwrite without `--force`, writes and reports. Anything a source cannot say becomes a `TODO(vx-migrate)` comment, never a silent wrong value.

### Turbo

Reads the root pipeline (`tasks` in Turbo 2, `pipeline` in Turbo 1), per-package `turbo.json` `extends` overlays and each package's scripts, through the same mapper `turbo()` runs live — so a repo reads the same whether you migrate it or run it as it is. Turbo's global fields become a generated root `vx-preset.ts` each config imports and spreads: TypeScript composition replaces global config. Turbo's `//#` root tasks are written to a `vx.config.ts` at the workspace root, which makes the root a project (core's D-39), and a package task's `//#x` edge reaches it.

| Turborepo                           | vx                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `dependsOn`                         | `dependsOn`, same micro-syntax (`$TURBO_ROOT$` deps are a TODO)                                   |
| `inputs`                            | `cache.inputs.files` (`$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/x` → `workspaceFiles`)            |
| `outputs`                           | `cache.outputs.files`, a negated one included                                                     |
| `env`                               | `cache.inputs.env` **and** `exec.env.passThrough` (child envs are isolated)                       |
| `passThroughEnv`                    | `exec.env.passThrough`                                                                            |
| `cache: false` / `persistent: true` | no `cache` block; `exec.persistent: {}`, with a TODO to set `readyWhen` when a task depends on it |

### Nx

Reads the **resolved** project graph only (`.nx/workspace-data/project-graph.json`; export one with `nx graph --file=.nx/workspace-data/project-graph.json`), through the same mapper `nx()` runs live — so a repo reads the same whether you migrate it or run it as it is. Targets Nx plugins infer at runtime are frozen as the snapshot saw them. `nx:run-commands` is the one shell line `nx()` runs (see [`nx:run-commands`](#nxrun-commands) above: where, parallel or in order, forwarded arguments, `env`, `readyWhen`) — storybook's `compile` is `cd ../../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli`; a plain `command` is that shorthand; `nx:run-script` is the package's script body with its `pre<name>` / `post<name>` hooks folded in (or `yarn run <name>` when the body calls yarn's `run` builtin; an empty script is the placeholder with a todo), `nx:noop` is a group task; **every other executor is an `nx-exec` line** carrying the executor and its resolved options, no TODO — keep `nx` and `@vzn/vx-migrate` installed for as long as a config runs one, and replace the line with the bare command (`vite build`, `tsc -p …`) when the target leaves Nx. A target with `configurations` writes one task per configuration (`build`, `build:ci`). Named inputs expand from `nx.json` when readable. An output path is kept as written, a `!` one too (`{projectRoot}/dist` → `dist`, `{projectRoot}/bin/tool` → `bin/tool`; one naming an unset `{options.x}` is dropped, as Nx drops it): vx reads a bare path as the file or the whole tree under it, so a directory and an extensionless binary both save and restore. vx derives package edges from `package.json`; an Nx graph edge with no manifest path (`implicitDependencies`, a tsconfig path) becomes, for each `^target` of the dependant, an explicit `pkg#target` edge to what Nx's own walk reaches — each dependency that has the target, and through one that lacks it, its dependencies — so the order and the key are Nx's.

### scripts

The last source: a root `package.json` whose scripts fan out, through the mapper `workspaceScripts()` runs live. A workspace with none is `vx init`'s.

### lage

Evaluates `lage.config.js` and maps it through the mapper `lage()` runs live; the table is [`lage()`](#lage--run-a-lage-workspace-unchanged)'s.

### wireit

Reads each `package.json`'s `wireit` block through the mapper `wireit()` runs live; the table is [`wireit()`](#wireit--run-a-wireit-workspace-unchanged)'s.

### moon

Reads `.moon/` and each `moon.yml` through the mapper `moon()` runs live; the table is [`moon()`](#moon--run-a-moon-workspace-unchanged)'s.

## `turboCache()` — a Turbo remote cache

Store vx artifacts in any server speaking Turbo's `/v8/artifacts` API — Vercel's hosted cache or a self-hosted implementation of the published OpenAPI spec (Bearer auth, `x-artifact-duration`, HMAC-SHA256 `x-artifact-tag` signatures). The wire is theirs; the bytes are vx's own artifacts under vx's own keys. The server is storage — the other tool cannot read what vx stores there, and vx does not read its entries.

Nothing is on by default. Declare the plugin in `vx.workspace.ts` and configure it explicitly. Reads try the local cache first and the remote only on a local miss:

```ts
import { defineWorkspace } from '@vzn/vx'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [
    turboCache({
      apiUrl: 'https://cache.example.com',
      token: process.env.CACHE_TOKEN,
      teamSlug: 'acme',
      // Optional: sign uploads and verify downloads (Turbo's artifact signature).
      // signatureKey: process.env.CACHE_SIGNATURE_KEY, teamId: 'team_acme',
    }),
  ],
})
```

Every option falls back to the tool's own environment variable, so a self-hosted setup carries over unchanged. A token with no `apiUrl` means Vercel's hosted Remote Cache (`https://vercel.com/api`), exactly as it does for `turbo` — so `npx turbo login && npx turbo link`, then `turboCache()` with `TURBO_TOKEN` / `TURBO_TEAM` set, is the whole hosted setup. Below the environment, as in Turbo, the root `turbo.json`'s `remoteCache` supplies `apiUrl`, `teamId` and `teamSlug`, and its `enabled: false` declines unless the options name a cache. With no token the plugin **declines** and the run stays local.

| Option            | Environment variable               | Meaning                                                                                                       |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apiUrl`          | `TURBO_API`                        | base URL of the cache server; default with a token: `https://vercel.com/api`; a `user:pass@` in it is refused |
| `token`           | `TURBO_TOKEN`                      | Bearer token on every request                                                                                 |
| `teamId`          | `TURBO_TEAMID`                     | `teamId` query parameter; required with `signatureKey`                                                        |
| `teamSlug`        | `TURBO_TEAM`                       | `slug` query parameter                                                                                        |
| `signatureKey`    | `TURBO_REMOTE_CACHE_SIGNATURE_KEY` | HMAC-SHA256 key (≥ 32 bytes, used raw); a download whose tag does not verify is a miss                        |
| `timeoutMs`       | —                                  | HEAD/GET/POST deadline (default 30 s)                                                                         |
| `uploadTimeoutMs` | —                                  | PUT deadline (default 60 s)                                                                                   |
| `retries`         | —                                  | resends of a request answered 429 / 5xx (not 501) or never connected (default 1, Turbo's); 0 turns them off   |

The signature is Turbo's current scheme (`artifact-signature:v2`: prefix, hash, team id and body, each length-prefixed, under HMAC-SHA256, base64 in `x-artifact-tag`). A signed body is written to a temp file before its tag can be checked, so one past core's artifact ceiling (2 GiB, at zstd's bound) is refused as it passes it, and is a miss.

Artifacts stream both ways on both wires: an upload sends the local artifact from its file, a download hands vx the response body to write straight to disk. A signed download must verify before vx sees a byte, so it is written to a temp file in the OS temp directory and verified from there (the tag covers the body's length, which a chunked response does not declare up front); a bad tag deletes the temp and reads as a miss, and a good one is handed over as a stream that deletes the temp once it is read or cancelled. A process that exits first (vx's Ctrl-C exit awaits no stream) deletes it on the way out.

## `nxCache()` — an Nx self-hosted remote cache

Store vx artifacts in any server implementing Nx's remote cache OpenAPI spec (`GET`/`PUT /v1/cache/{hash}`, Bearer auth, immutable records — a second write of a hash is `409`, which the plugin treats as done). Same rule: the wire is theirs, the bytes are vx's. A download asks for `Accept: application/octet-stream`, as Nx's own client does: an API gateway that keys binary media on `Accept` base64-encodes anything else (nx#33092); `turboCache()` asks the same way.

```ts
import { defineWorkspace } from '@vzn/vx'
import { nxCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [nxCache({ server: 'https://cache.example.com', accessToken: process.env.CACHE_TOKEN })],
})
```

Every option falls back to the tool's own environment variable; with nothing configured the plugin **declines** and the run stays local.

| Option        | Environment variable                       | Meaning                                                       |
| ------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `server`      | `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`       | base URL of the cache server; a `user:pass@` in it is refused |
| `accessToken` | `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | Bearer token; omit for a server that runs open                |
| `timeoutMs`   | —                                          | per-request deadline (default 30 s)                           |
| `retries`     | —                                          | resends, as `turboCache()`'s (default 1)                      |

The Nx spec has no existence probe, so `has` (the `--dry` prediction; the prefetch pass calls `get`) is a `GET` whose body is cancelled before it answers. The wire carries no producing-task duration, so a remote hit reports none.

## Remote-cache behaviour (both)

- A remote error degrades to a **miss** and a warning that names the request, the artifact and the server — `vx/turbo-cache: upload 32248a2a7c89e241 to https://cache.example.com/v8/artifacts failed: no answer within 60000 ms` — never the token. The run never fails because of the cache.
- The same failure is said once per run: an unreachable server fails the probe, the download and the upload alike, and the run prints the first and, at its end, `vx/turbo-cache: 2 more requests failed the same way: Unable to connect. Is the computer able to access the url?` (core's `LayeredCache` does the counting, for every cache plugin).
- A request answered `429` or `5xx` (not `501`), or one that never connected (a refused port, an unresolved host), is sent again after 2 s — a `429` after its `Retry-After`, capped at 10 s — as Turbo's client does. A spent deadline is not: it has already cost its wait.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process — including the requests already in flight when the refusal lands, which degrade in silence rather than repeating it (a six-project run printed five identical lines before 2026-09-20).
- Policy (`--cache=remote:r`, …) is enforced by core's `LayeredCache`, which the plugins wrap — a read-only token pairs naturally with `remote:r`.

## Testing

`bun test` runs the Turbo, Nx, moon, wireit, lage and workspace-scripts plugins over fixture workspaces (the Nx one against a fake `nx` whose graph export and `runExecutor` are stubs, so the vx → `nx-exec` → executor → cache round trip is real), the migrate CLI over both sources, and each remote-cache wire against a strict in-memory implementation of its spec plus a full `vx run` round trip (miss → upload → local wipe → restore from the server). A separate suite points both plugins at a HOSTILE server — 500 on every request, 401, a server that never answers, and a body that is not an artifact — and pins that each one degrades to a miss with the run still green. `tests/nx-exec-live.test.ts` runs `nx-exec` against REAL Nx when `VX_NX_MODULES` names a directory whose `node_modules` holds `nx`, `@nx/js` and `typescript` (CI installs one under `packages/vx-migrate/.nx-live` and sets `VX_REQUIRE_NX=1`, so an absent install fails there instead of skipping).

## History

`vx migrate` was a core verb until 2026-09-10; it moved here so core reads no other runner's format. `@vzn/vx-turbo`, `@vzn/vx-turbo-cache` and `@vzn/vx-nx-cache` were separate packages until 2026-09-11, when adoption became one package. Typing `vx migrate` prints the pointer here.
