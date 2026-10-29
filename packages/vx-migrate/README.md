# @vzn/vx-migrate

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-migrate/> · source: <https://github.com/vznjs/vx>

Everything for adopting [`@vzn/vx`](https://vznjs.github.io/vx/) from Turborepo, Nx, Vite Task or plain `package.json` scripts, in one package with zero dependencies:

- **`turbo()`** — a temporary start for a Turbo repository: the plugin makes each package-manager member a project (`discover`; core finds only directories holding a `vx.config`) and fills vx's `project` stage from `turbo.json` and each package's `package.json` scripts until the migrator writes native config.
- **`nx()`** — the same temporary start for an Nx repository, filled from Nx's resolved project graph. Executor targets (`@nx/js:tsc`, `@nx/vite:build`, your own) run as themselves through **`nx-exec`**, one executor per process.
- **`bunx @vzn/vx-migrate`** — write one `vx.config.ts` per workspace package from your `turbo.json`, an exported Nx project graph, vite-plus's `run.tasks` (Vite Task, `vp run`), or else each package's `package.json` scripts, plus the workspace file every run needs. Runs without a workspace file, so it is the first command, not the second; `vx init` runs it in any repo with a `package.json`.
- **`turboCache()`** and **`nxCache()`** — keep the remote cache you have: any server speaking Turbo's `/v8/artifacts` API (Vercel's hosted cache included) or Nx's self-hosted `/v1/cache` spec.

```sh
bun add -d @vzn/vx @vzn/vx-migrate
```

In a Turbo or Nx repo, `bunx @vzn/vx init --keep` runs this package, which
writes the `.vx/workspace.ts` that declares `turbo()` or `nx()`, installs
what it imports and writes the lock. Where the repo shows a remote cache it
declares `turboCache()` or `nxCache()` too; by hand it reads:

```ts
// .vx/workspace.ts — a Turbo repo mid-migration, with its remote cache
import { defineWorkspace } from '@vzn/vx/config'
import { turbo, turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turboCache(), turbo()] })
```

The package exports `turbo`, `nx`, `turboCache`, `nxCache` and their options types (`TurboPluginOptions`, `NxPluginOptions`, `TurboCacheOptions`, `NxCacheOptions`); the mappers and cache clients are internal.

## `turbo()` — a Turbo repo, mid-migration

Until `bunx @vzn/vx-migrate` writes native config, `vx run build --all` maps every package's `build` script the way `turbo run build` would: `dependsOn` edges (`^build`, same-package deps, `pkg#task`), `inputs` as every task's key and `outputs` as the cache block, `env` / `passThroughEnv`, `cache: false`, `persistent`. Turbo's global fields (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`, Turbo 1's `globalDotEnv`) are inlined into every task; a `*` env name (`NEXT_PUBLIC_*`) expands over the run's environment, as Turbo matches it; `*` is Turbo's only wildcard (`\*`, a leading `\!`, `?` and `[` are literal), and a literal vx cannot key (unkey's `NEXT_PUBLIC_\*`) is left out, reported once only when the run's environment sets it; per-package `turbo.json` overlays apply. A `turbo.jsonc` (Turbo 2.5+) is read wherever a `turbo.json` would be, at the root and in a package; a directory holding both is refused, as Turbo refuses it, and a workspace root with neither is refused, naming the fix. Turbo 2's framework inference (a package on `next` has `NEXT_PUBLIC_*` and `NEXT_DEPLOYMENT_ID` hashed and passed; Turbo's whole table, `expo`, `nuxt`, `remix`, `@sveltejs/kit` and the rest, each package taking the first framework it matches, as Turbo does, and leaving out names under the platform's `TURBO_CI_VENDOR_ENV_KEY`) applies too: the prefix expands over the run's environment into that package's tasks, and a task's `!` entry takes names back (`bunx @vzn/vx-migrate`, which writes files for another environment, names each framework and its packages in a note instead). Turbo's builtin env applies as Turbo's source has it: `VERCEL_ANALYTICS_ID` and `VERCEL_TARGET_ENV` are keyed in every task (a `globalEnv` `!` entry such as `!VERCEL*` takes them back), Next's skew rule keys `VERCEL_DEPLOYMENT_ID` when `VERCEL_SKEW_PROTECTION_ENABLED=1`, and the literal names of Turbo's builtin pass-through list (`TZ`, `HOME`, `CI`, the Vercel, Docker and IDE names) reach every task unkeyed. Its wildcard families (`VERCEL_*`, `GITHUB_*`, `DOCKER_*` and the rest) are not matched against the run's environment: `exec.env.passThrough` is keyed by name, so a live match keyed each machine apart. The written config keys the defaults and `VERCEL_DEPLOYMENT_ID` always (a miss where Turbo would hit, never a stale hit) and passes the same literal names from the preset; a note names the wildcard families to add where a task reads them. What runs is what a migration would have written, minus the file: the key a task derives here equals the key the written config would derive.

| Option | Meaning                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| `root` | Directory holding `turbo.json`, relative to the workspace root or absolute. Defaults to the workspace root. |

### Locking

`vx lock` freezes the evaluation of written `vx.config.*` files only. A package that has none gets its tasks from `turbo.json` on every run, so the lock records nothing for it and `vx lock --check` does not audit it; `turbo.json` is its source of truth, committed like one.

### What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from `turbo.json`.
- The mapping's gaps are the migration's gaps, reported as warnings by `vx lock` (and `vx lock --check`), never on a run, instead of `TODO(vx-migrate)` comments: `$TURBO_ROOT$` tasks, an env name vx cannot key that the run's environment sets (`FOO_?`, which Turbo reads literally), unknown turbo keys. A persistent task's readiness note (`readyWhen`) is reported only when something depends on it — with no dependent there is nothing to gate (refine printed it for 375 `dev` targets a run). `bunx @vzn/vx-migrate --dry` lists the same set once. Each gap is one line for every task that carries it, not one per task (n8n marks `dev` and `watch` persistent in most of its 84 packages; astro negates `vendor/**` in the outputs of 57 tasks). A per-package `{ "extends": false }` with nothing else is Turbo's opt-out and maps to no task; with keys, the task runs on those keys alone. A glob that climbs out of the package (`../../packages/app-store/*.generated.ts`) is re-anchored on the workspace root as a `workspaceFiles` glob. A negated output under a literal-rooted one (`dist/**` minus `!dist/**/*.map`) takes its paths back (see `outputs` below); one against a wildcard-rooted output (medusa's `*/**` minus `!src/**`) makes the task uncached, because the clean before exec would otherwise delete the sources — declare the exact outputs in a vx.config to cache it.
- The cost is the stage's: on a 1,000-package workspace with no `vx.config` files the mapping loads in about 42 ms where 1,000 evaluated configs load in 22.
- The mapping is kept in `<cache dir>/vx-migrate-turbo-mapping.json`, keyed on every `turbo.json` / `turbo.jsonc`, every package manifest, the mapper's own code and the environment variable names a wildcard can match (one in a Turbo config or Turbo's framework table) or core cannot key, so an unrelated variable keeps it; a run with none changed reads it instead of mapping (astro, 562 packages: ~40 ms of mapping against ~12 ms of key reads).
- The mapping is read once per run, never once per process: under `vx watch`, a `package.json` script edit or a per-package `turbo.json` overlay edit is the next cycle's tasks. The root `turbo.json` is no task's input and lives in no project dir, so an edit to it is not a cycle — restart the watch.

### The mapper (`mapTurboWorkspace`)

The plugin and the CLI read a repo the same way: the mapper the plugin runs live is what `bunx @vzn/vx-migrate` writes `vx.config.ts` per package from, splicing Turbo's global fields in as imports of a generated `vx-preset.ts` (its exports alone, no comments), where the plugin inlines the values; a global input another task writes to is taken back after the spread (`[...globalInputs, '!packages/plugin/dist/**']`), as the plugin takes it back from the inlined values. `splice` is where the two consumers meet; `uses` names which globals a task drew on. Before 2026-09-10 the mapper lived in `@vzn/vx` itself; until 2026-09-11 the plugin was its own package, `@vzn/vx-turbo`.

Rules:

- **A task exists for a package only when the package declares the script** — Turbo's own rule. An absent script is silent; a script key whose value cannot be a command (a number, `null`, an empty string, an array) produces a `task: null` entry whose todo says why, rather than a config that fails to load.
- **Definition order**: root `pkg#name` if there is one, else root `name` (the first replaces the second whole, as Turbo looks it up), then each package config its own `turbo.json` extends (`"extends": ["//", "shared"]`, read by Turbo 2.11, refused by 2.5; nearest last, a parent missing or a cycle refused as Turbo refuses it) and its own, each winning field by field, except an overlay array holding `$TURBO_EXTENDS$` (Turbo 2.5+), which is the inherited list plus the overlay's other entries (`inputs: ["$TURBO_EXTENDS$", "config.json"]`).
- **The command is the script body** with its `pre<name>` / `post<name>` hooks joined in, in that order, through core's `foldScriptHooks`: each part in its own subshell, the chain stopping at the first that fails, forwarded `--` args reaching the body alone (npm and pnpm run them around `<name>` without being asked; novu's `prebuild` copies the CSS its `build` inlines), one process less per task than `pnpm run <name>` — except a body that calls yarn's `run` builtin (`run -T rollup -c`, `run clean && run build`; yarn ≥ 2 runs scripts in its own shell), which is `run: command not found` in sh: it runs as `yarn run <name>`, as Turbo and Nx run it, and yarn ≥ 2 runs no hooks, so none are joined there. Nor are they where the package's manager runs none, as for `bunx @vzn/vx-migrate`'s scripts (Yarn 2+, npm under `ignore-scripts=true`, pnpm under `enable-pre-post-scripts=false` or `enablePrePostScripts: false`; an `.npmrc` or `pnpm-workspace.yaml` change maps afresh): Turbo and Nx run `<pm> run <name>`, so the hook never ran there. A Yarn Plug'n'Play workspace (`.yarnrc.yml` with no `nodeLinker`, or `pnp`) has no `node_modules`: a dependency resolves only through `.pnp.cjs` and a bin only through yarn's shims, so there every script runs as `yarn run <name>`, and a `nodeLinker` change maps afresh. Same rules for `nx:run-script` below (strapi and novu, 2026-09-11).
- **Turbo 2.11's task `command`** (`futureFlags.experimentalTaskCommand`) wins over the script, as Turbo holds it: an argv is the command — each word quoted, run from the package dir, no `pre`/`post` hooks — and gives the package the task even with no script (turborepo's `@turbo/types#build`, `docs#schema`); `null` or `[]` is Turbo's no-op node, no task even where the script exists, its edges passed through; a per-toolchain map applies its `javascript` entry (or `typescript`, Turbo's alias), and without one the script runs. A shape Turbo would refuse keeps the script, with a todo.
- `dependsOn`: `^x` passes through when some package runs `x` or turbo.json defines it, and is dropped otherwise (core refuses a `^x` no project declares as a typo); `pkg#task` is kept only when `pkg` emits `task` (else a todo: edge dropped); a same-package task Turbo defines but the package has no script for is Turbo's no-op node, so its own edges pass through in its place (`test → codegen → ^build` with no `codegen` script is `test → ^build`); another package's `^x` or `pkg#x` reaches such a node through a group task when its edges name a task of its own package or another (with-tailwind's `ui` has no `build` script; its `build` builds `build:styles` and `build:components`, and `web#build` waits on them), and so does one whose `^` edge names another task (rallly's script-less `build` holds `^db:generate`), while one whose only edge is `^` to its own name needs none, since core's `^x` walks past a package without `x`; a no-op node nothing else reaches is a group too in a package nothing but the root depends on, since no dependant's `^` edge runs its edges there (vercel/ai's `turbo run type-check` builds each example through its script-less `type-check: [build]`, and kitchen-sink's `turbo run test` builds `@repo/ui` for `admin`, which has no `test` script); elsewhere it is none, its edges run by its dependants'; a name Turbo does not define has no edge; `$TURBO_ROOT$` deps are a todo. A task turbo.json defines and no package has a script for (documenso's `lint`, shadcn-ui's `check`) is a group task in each package that defines it, its edges kept (a `pkg#task` edge only in `pkg`, a `//#task` edge in a group of the same name on the root project), so `vx run lint` runs Turbo's no-op nodes and exits 0 as `turbo run lint` does. Root `//#task`s run in the workspace root, as under Turbo: `turbo()` names the root a project through core's `discover` stage when turbo.json declares one (no `vx.config` needed), as it names every package the package manager lists, and `//#x` in `dependsOn` is an edge to it, named by the root `package.json` `name`; a root task's globs are the workspace's (`workspaceFiles`), since Turbo hashes a root task over the whole repo; with no root project (a root `package.json` with no `name`, or one a package holds) they are a note and such an edge a todo. Turbo runs no plain task in the root package of a monorepo, and neither does `turbo()`; in a single-package repo (no workspaces, Turbo's `non-monorepo` example) turbo.json's plain tasks run on the root package, as under Turbo.
- A transit node (Turbo's documented pattern, its with-vitest example: `transit: { dependsOn: ["^transit"] }` with no script anywhere, and `test: { dependsOn: ["transit"] }`) is a key-only task in each package that defines it: a keyed group (no command, nothing spawns) keyed on its inputs, with its `^transit` edge, so a dependant's `test` re-keys on its dependencies' sources as Turbo re-hashes it. A `^` task that some package has a script for, or that nothing depends on, is no transit node. A package without the script of a `^` task others run gets the same key-only task, as Turbo hashes a no-op node there: an edit to it re-keys its dependants. A `build` whose only edge is `^build` is not written: core gives every project with no `build` that node (solid's three script-less packages each got a `build` of their own). A dependency without the script whose own edges lack `^x` gets it too, so a `^x` stops there as Turbo's does (opencode's `build: { dependsOn: [] }`: core walked past to the builds below, which Turbo's `^build` never reaches).
- `with` (tasks Turbo runs alongside, `web#dev` with `api#dev`): an edge to each sidecar that is persistent, so vx starts the task once the sidecar has spawned and runs the sidecar only when the task runs; a sidecar that ends would be waited for, so it is a todo instead, and a pair that names each other keeps one edge (two would be a cycle). A task with no script whose `with` names persistent sidecars (Turbo's with-tailwind example: `ui` has no `dev` script, its `dev` starts `dev:styles` and `dev:components`) is a group task that depends on them.
- `inputs`: a structured entry (Turbo 2.11) is its `globs`, plus `**/*` with `withDefaults`, for `startup` and `jit` alike; `dependencyOutputs` adds none where the producer is cached (vx hashes each dependency's key into it); from a `cache: false` producer (vercel/vercel's `//#generate:cache-keys`, which records the host) the named files, or its outputs, are a `inputs.workspaceRuntime` probe, and `inputs.tasks` leaves the producer out, so core answers the probe after it ran. Then: absent or `[]` → `**/*` (Turbo's default); `$TURBO_DEFAULT$` → `**/*`; exclusions alone narrow `**/*`; `$TURBO_ROOT$/<path>` → `inputs.workspaceFiles` (negation kept); any other `$TURBO_ROOT$` use is a todo. `globalDependencies` and Turbo 1's `globalDotEnv` land in `workspaceFiles` too (Turbo hashes `globalDependencies` apart from a task's own inputs, so neither's `!` reaches the other's files, and vx subtracts each `!` from the whole list: a `!` that may reach the other side's files is dropped, which keys more, never a stale hit; Turbo 2.11's `global.inputs` joins each task's inputs, where its `!` entries apply), and a task's Turbo 1 `dotEnv` in its `files`. Turbo 1's `$NAME` entries, in `globalDependencies` or a task's `dependsOn`, are env vars: they join `inputs.env` and `exec.env.passThrough`. A package nested in the task's package (cal.com's apps inside `@calcom/app-store`) is hashed by Turbo with its parent, and core's globs stop at a project: each glob that reaches one is also listed in `inputs.workspaceFiles`. Turbo's glob grammar is translated as Nx's is (`*.[jt]s` is `*.{[jt],j,t}s`); an input with no safe form widens to `**/*` with a todo. A wildcard `X/**` input, `!` or not, also lists `X`, as outputs do: Turbo's `**` matches zero segments, so `*/**` keys on the package-root files too. A `.env`-shaped input (`.env*`, `.env.local`, a task's Turbo 1 `dotEnv`, create-turbo's `globalDependencies: ["**/.env.*local"]`) is gitignored as a rule, so it is keyed by a probe that hashes the `.env` files it can name (`inputs.runtime`) or, for a root entry, the files its root-relative globs name, hidden ones too, as Turbo's `*` matches them (`workspaceRuntime`; `**/<name>` is a `find -name` that skips `node_modules`, and another `**` walks the workspace), rather than as a file glob git never reports. A package whose `.env` globs all sit at its root gets a one-shell probe of that directory; one below the root walks the package.
- `outputs`: `$TURBO_ROOT$/<path>` → `cache.outputs.workspaceFiles`; a negated output rides beside its positives and takes its paths back from the clean, the save and the restore (Next's `.next/**` minus `!.next/cache/**` keeps the cache), and one with no positive beside it takes back nothing and is dropped. Past its first segment an output takes Turbo's grammar (`dist/**/*.[cm]js`); the first stays a literal (a route directory). A wildcard `X/**` also lists `X`: Turbo's `**` matches zero segments, so medusa's `*/**` caches the package-root `tsconfig.tsbuildinfo` too (its `package.json` is taken back, below); a literal `dist/**` needs no `dist`. An output whose first segment is a wildcard (`**/*.d.ts`, medusa's `*/**`) stays cached, as in `nx()` (`turbo()` 2026-10-14): Turbo never cleans an output, vx cleans it before every run and every restore, and such a glob can reach the sources; core never cleans a committed file, and every untracked file it reaches is deleted, which `vx lock`'s warnings name (`output "*/**": … every untracked file this glob reaches is deleted`). Negations beside it (`!src/**`) keep what they name. Without git the files cannot be told apart, and the task runs uncached with a todo. A glob that reaches no tracked kind gets no warning: one segment with a literal extension the package tracks no file of (`*.xml`), `**/<dir>/**` when the package tracks nothing under a directory of that name (vercel/ai's `**/dist/**`), and a first segment no tracked top-level entry matches (tldraw's `dist-*/**`). An output that covers the package's own `package.json` (trpc's client build lists it: the build rewrites `exports`) takes the manifest back with `!package.json` and keeps the cache, in `turbo()` as in `nx()` (2026-10-03): vx would otherwise delete it before every run. The build rewrites a file it may list as an input (`@vzn/vx-lockfile` lists `package.json`), so the Turbo mapping also sets `inputStability: { strategy: 'mutable' }` and an identical rewrite counts as unchanged. So does one that covers the package's vx.config; `turbo()` and `nx()` check the config the package has, and `vx-migrate` the one it writes, so sanity's `*.js` shims stay cached beside none. `nx()` keeps a wildcard-first output cached the same way (2026-10-03). A committed file under an output (typescript-eslint's `data/sponsors.json` in a cached `data`) needs nothing: core never cleans a file git tracks, so it survives and the task keeps its cache. A task whose command runs `tsc` that writes a `.tsbuildinfo` (`-b`, `composite` or `incremental`, read through the tsconfig's `extends` and, for `-b`, its `references`) outside its outputs also outputs that file: tsc re-emits only what its buildinfo calls changed, so with `rootDir: "src"` and `outDir: "dist"` its `tsconfig.tsbuildinfo` beside the tsconfig survived the clean before a miss and the miss cached a `dist/` holding only the edited file. Nx infers the file as an output; Turbo never cleans `dist/`.
- A `**` glued to text in an input, output or `globalDependencies` glob is read as Turbo reads it (turborepo#5431): `src/**.ts` → `src/**/*.ts`, `gen**` → `gen*/**`. Core refuses the glued spelling.
- `env` / `passThroughEnv`: explicit names go to `inputs.env` (env only) and `exec.env.passThrough` (both, plus both globals); a wildcard expands over the run's environment under `turbo()`, which maps where the tasks run (a new variable name such a wildcard matches maps afresh); the CLI, which writes for another environment, lists the names the task's package and its workspace dependencies spell (a root task: the whole repo; clerk's `E2E_*`), noted once per entry, and one nothing spells is a todo; `*` is the only wildcard, as in Turbo, so `\*`, a leading `\!`, `?` and `[` are literal: unkey's `NEXT_PUBLIC_\*` names one variable, which vx cannot key, so it is dropped and reported once for the workspace with the count of tasks naming it (openstatus's root `build` env `\*` had written one todo into each of 45 configs; `turbo()`: only when the run's environment sets it, as Turbo hashes nothing otherwise); and a `!` entry (openstatus' `!NEXT_PUBLIC_VERCEL_URL`) removes the names it matches from its list, with no todo, since vx matches no name it is not given. A name both a global list and the task's own list carry is listed once. A name that is no shell variable name (`p-q`) is keyed but left out of `exec.env.passThrough`, as `sh` drops it before the task runs.
- Framework inference (Turbo hashes and passes Next's `NEXT_PUBLIC_*`, Vite's `VITE_*`, … for a package that depends on the framework): `turbo()` expands the prefix over the run's environment; the CLI writes the names the tracked source and `.env.example` of the package and its workspace dependencies spell (the bare prefix, as a `startsWith` test spells it, is none) (Next bundles theirs: cal.com's web, 23 alone, 58 with them), and a note asks for any only an installed dependency reads.

- **Two tasks of one package on one output path** (strapi's `build`, `build:code` and `build:types`, all on `dist/**`): vx cleans a task's outputs before it runs and before a restore, so the loader refuses two cached tasks whose outputs provably overlap. Under vx's default `rules.exclusiveOutputs` an edge between the two changes nothing (twenty's `build:individual` writing into `build`'s `dist`). The mapping resolves it before the file is written — `build` keeps its cache, else the task with a `^` edge, else the first declared (typescript-eslint's `typecheck` has `^typecheck` and writes declarations into `build`'s `dist`: keeping it left `build` uncached); the rest run uncached with a todo naming the keeper and the fix, their own output path. A shared tsc incremental file (create-t3-turbo's `build` and `typecheck` both on `.cache/tsbuildinfo.json`) stays with the keeper alone, and the other task keeps its cache when it emits nothing else (a typecheck); one that emits more runs uncached, as `tsc --incremental` skips files the keeper's tsbuildinfo calls built. When either side is a directory at any depth (solid's build `**/dist`, its types `**/types`), the two meet only where one tree nests in the other: the keeper takes the sibling's glob back (`!coverage/**`, `!**/types`) and both keep their cache, as under Turbo. Same rule for Nx targets.
- **A task whose inputs read another task's outputs** (a `test` keyed on `**/*` beside a `build` writing `dist/**`): `vx lock` refuses it, since such a key cannot be known before the producer ran. Each overlapping output is taken back from the reader's inputs with `!` (`['**/*', '!dist/**']`), in package and workspace inputs alike, and a workspace output another package writes into this one is taken back from its package inputs too; Turbo and Nx hash what git tracks, and a build's outputs are not, so the key reads what the adopted tool read. A literal input another task writes cannot be taken back: that task runs uncached with a todo. A committed file under such an output is still a source: a reader the `!` would hide it from runs uncached with a todo. A keyed group (an `inputs:<name>` twin, a transit node) runs nothing, so core lets it read what a task writes: it gets no `!` for a literal, the `!` that would hide a committed file goes, and it keeps its key (typescript-eslint's ast-spec commits the `*.shot` snapshots its `test` outputs, and its twin was written as `{}`, which core refuses). An output that names one committed file (eslint's `eslint-suppressions.json` in a `lint` task's outputs) is dropped, and so is the `!` each reader got for it: the file stays in every key, as Turbo and Nx hash it, and the readers stay cached. Same for Nx targets.
- **Two packages' tasks on one workspace output** (cal.com's shared `post-install` writes `../../node_modules/@prisma/client/**` from every package with the script): core refuses two cached tasks on one path with no edge between them, so `turbo()` (and `nx()`) keeps the first (in package and task order) cached and runs the rest uncached, each with a todo naming the keeper. A package's own outputs count at their workspace path: typescript-eslint's root project caches `dist` and each package's typecheck `dist/packages/<name>`, one path twice. Edges across packages are not read, so an ordered pair loses its cache too.
- `cache: false` or `persistent: true` → no `cache` block, the task still keyed on its `inputs` and `env` as Turbo hashes it; a persistent task gets `exec.persistent: {}` and, when some task depends on it, the consumer's `persistentTodo`.
- A task's `description` (Turbo 2.11.5's schema) is the vx task's `description`.
- `outputLogs: "new-only"` maps to nothing: frames for the tasks that ran and a one-liner per cache hit is vx's default flow already. The other values are per-run in vx, so they are a todo naming the flag (`vx run … --output-logs hash-only`).
- `interruptible` maps to nothing: `vx watch` keeps a persistent task up across cycles and restarts it only when its config changes or it dies.
- A task's `tags` (Turbo main, after 2.11.5) map to nothing: Turbo keeps them out of the hash and the run.
- A task's `experimentalCI` maps to nothing: Turbo reads it for external CI tooling and acts on nothing.
- `envMode: "loose"` (top-level or in `global`, or `TURBO_ENV_MODE=loose`, which wins) is a note: Turbo hands every task the whole environment, vx only the declared names.
- The workspace keys vx has a home for, top level or in `global`, fill what `.vx/workspace.ts` leaves unset: `run.concurrency` (`"10"`, `"50%"` of the cores) → `run.concurrency`. `TURBO_CONCURRENCY` wins over turbo.json, as under Turbo; a set one decides, its `0` included. `cacheMaxSize` / `cacheMaxAge` map to nothing: no vx run evicts, `vx cache clean --max-size / --older-than` does.
- `TURBO_FORCE=true` (or `1`), `turbo run --force`, turns every cache read off through the workspace's `cache.policy`: each task runs and refreshes the local cache. The remote is written only where `.vx/workspace.ts`'s own `cache.policy` names it, so a laptop's forced run never writes the cache CI reads; `vx run --force` is the flag. A `--cache-policy` or `VX_CACHE_POLICY` replaces the workspace's policy, this included.
- `TURBO_SCM_BASE`, the base `turbo run --affected` compares with, is the run's base commit (`setBranch({ base })`): a bare `vx run build --affected` compares with the same ref. With it unset on GitHub Actions (`GITHUB_ACTIONS`), Turbo's own base applies: a pull request's `GITHUB_BASE_REF`, else the push event's `before` from `GITHUB_EVENT_PATH`.
- Turbo hashes each package's `microfrontends.json` (or `.jsonc`) into every task, or the one file `VC_MICROFRONTENDS_CONFIG_FILE_NAME` names; so does `turbo()`.
- `TURBO_ROOT_TURBO_JSON`, Turbo's root config path (against the cwd), is refused when it names another file than the workspace root's `turbo.json` or `turbo.jsonc`: `turbo()` reads only that one.
- Turbo 2.11's `global` block (`futureFlags.globalConfiguration`) is read as the `globalDependencies`, `globalEnv` and `globalPassThroughEnv` it replaces, except that a task's `!` input takes a `global.inputs` file back, as Turbo prepends them to each task's inputs.
- An unknown Turbo key is a todo naming it; `extends` is accepted and ignored (the overlay order above is what it means).

## `nx()` — an Nx repo, mid-migration

```ts
// .vx/workspace.ts — an Nx repo, mid-migration
import { defineWorkspace } from '@vzn/vx/config'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
```

Until `bunx @vzn/vx-migrate` writes native config, `vx run build --all` maps every project's `build` target the way `nx run-many -t build` would. `nx()` is also the repo's edge source: each project's dependencies on Nx's graph (package deps, `implicitDependencies`, imports) are its `deps`, so `^build` follows Nx's order with no lockfile plugin. The plugin reads Nx's **resolved** project graph — where Nx has already applied `targetDefaults`, expanded `namedInputs`, inferred targets through its plugins and interpolated `{projectRoot}` and friends — so nothing is re-derived here. Per target: `nx:run-commands` and a plain `command` run as one shell line that does what Nx's run-commands does (below); `nx:run-script` is the package script, with the `$npm_package_name`, `$npm_package_version` and `$npm_lifecycle_event` it reads defined as `<pm> run` sets them (a migration reads the name and version from the manifest it imports, so a bump reaches them; any other `$npm_*` is a todo); `nx:noop` is a group task, and so is a target with neither an executor nor a command that has dependencies, as Nx normalizes it (one with none is dropped, as Nx drops it); **every other executor runs through `nx-exec`** with the executor and its options on the command line. Every target is keyed on its `inputs` (a target Nx does not cache on its own inputs alone, no `^` named inputs, since Nx hashes no dependency's hash into it), and a target Nx caches (`cache: true`, or the legacy `cacheableOperations` list in `nx.json`) gets its `outputs` as the cache block, with no `inputs` meaning Nx's `default` and `^default`, named inputs resolved per project (nx.json's under the project's own; one neither defines, such as an `extends` preset not installed, keys the whole project with a todo, never an empty list that keys the task on its config alone), `{workspaceRoot}` / `{projectRoot}` / `{projectName}` interpolated anywhere in a path as Nx does (`{workspaceRoot}/coverage/{projectRoot}`), Nx's glob grammar translated (`*.[jt]s` is `*.{j,t}s`; the default `production` negation `?(*.)+(spec|test).[jt]s?(x)` becomes brace sets, a narrowing only a negation may take; what has no safe form is a todo), a project fileset of negations alone (nx-recipes' `noMarkdown`) starting from every project file, as Nx reads it, and an output outside the project dir (`dist/<project>` at the workspace root, Nx's default layout) a `workspaceFiles` output, an output outside the workspace (an old generator's `reportsDirectory: "../../coverage/<lib>"`) a todo and dropped, as vx caches only inside it, an output whose first segment is a wildcard (`{projectRoot}/**/*.d.ts`) cached, with the committed files it reaches kept (core never cleans one) and the rest cleaned before the run, and an output that covers the project's own `package.json` or vx.config cached with the file taken back by `!`; `dependsOn` becomes the edges (`^build` — dropped when no project has the target, as Nx gives it no edges and core refuses a `^name` nothing declares — `build`, `project:target` → `project#target`, everything past `project:` one target name, as Nx joins it (`ui:build:esm` is ui's `build:esm`; `ui:build:ci` names target `build:ci`, never `build`'s `ci` configuration, and is no edge where ui lacks it), this project's own target winning over a project name, `{ target, projects }` → each matched project's task, `projects` read as Nx's `findMatchingProjects` reads it: a name or a list of names, globs over names and over project directories (`libs/*`), `name:` / `tag:` / `directory:` labels, a bare word as a word in a name, and `!` exclusions; an edge to a target its project lacks is dropped without a word, as Nx drops it — `targetDefaults` that give every `typecheck` a `codegen` one project has; `^name` is every dependency's `name` whatever it holds, `^rsbuild:typecheck` included; a target glob — `test:e2e--*`, `^build-*`, `ui:build-{esm,cjs}`, a `{ target }` object's — expands over every target name in the workspace, as Nx 19.5+ does, before those rules; a same-project glob keeps its own project's matches), `{ env }` inputs pass through (one that is no shell variable name is keyed only), `{ runtime }` inputs run at the workspace root as Nx runs them (`inputs.workspaceRuntime`), with `{workspaceRoot}`, `{projectRoot}` and `{projectName}` written in as the paths and name they stand for (Nx runs the command as written, so `cat {workspaceRoot}/v.txt` keyed on cat's error there), and a command that exits non-zero keys its error and exit code and the task runs on, as Nx hashes its output whatever it exits (`git describe` in a repo with no tags): the written probe is `(<command>) || echo "exit $?"`, a `{ fileset, includeIgnored: true }` literal (Nx 23 hashes it from disk, gitignored or missing) is read by such a probe, since vx's globs see only what git lists, and a glob of one is a todo, a target that says `continuous` — or, in a graph from an Nx older than that field, runs a server executor (`@nx/vite:dev-server`, `@nx/next:server`, …) — is a persistent task and never cached, ready on spawn as Nx has it (Nx starts the dependents once it has started; a run-commands `readyWhen` gates them, below). The target's name never decides: a cached `dev` caches like any other target (nx#32610). `parallelism: false` (Nx runs the target alone) has no vx form and is a todo naming `--concurrency 1`; `syncGenerators` (Nx runs them first) is one workspace note per generator list, counting its tasks and naming `nx sync`; nx.json's `sync.globalGenerators` is one note per run naming `nx sync`. A target with `configurations` is one task per configuration (one whose name another target holds, `vite`'s `build` beside an inferred `vite:build`, is not written, with a todo, as Nx resolves `a:vite:build` to the target): `build` carries the default configuration's options, `build:ci` the `ci` one, and an edge of `build:ci` (own, named or `^`) reaches each target's `ci` task where it declares one, else its default, as Nx's `resolveConfiguration` does; a `^build` there becomes one edge per dependency Nx links. A `^name` input (`^production`, `{ input, dependencies: true }`, the pre-17 `{ input, projects: "dependencies" }`; `projects: "self"` is the own input, as Nx 23 still reads both) is what Nx hashes: each dependency's `name`, over the project graph, whether or not a task edge exists. A `{ input, projects }` list is read as `dependsOn`'s `projects` is; with `dependencies: true` beside it, both the listed projects' dependencies' input (Nx 24's reading) and this project's `^input` (Nx 23's) are keyed. Each project some reader reaches gets an `inputs:<name>` task — a keyed group (no command, nothing spawns, not counted in the run summary) keyed on its own `name` input, depending on its Nx dependencies' twins (a project nothing reaches gets none) — and a task that reads `^name` depends on its direct dependencies' twins, so the whole closure goes into its key with each project hashed once. A dependency FILESET (`^{projectRoot}/tsconfig.lib.json`, `{ fileset, dependencies: true }`, which Nx's own inferred `typecheck` writes) is keyed the same way: its twin, `inputs:fileset-<hash>` (a glob's `*` is no task name; the task's description names the fileset), keys on that fileset in each project. A twin lists its project's `package.json` and `project.json` first (whichever exists; Nx keys every task on its project's manifest and configuration): a fileset that matches nothing (an absent `tsconfig.spec.json`, a dependency's unbuilt `*.d.ts`) is nothing to Nx and no "matched no files" warning, and the file appearing re-keys its readers. The twins spawn nothing and stay out of a run's output and task count, so `vx run build` counts the tasks `nx run-many -t build` does. A path input inside an output one of the project's own targets declares (TanStack/table's `public` input lists `{projectRoot}/dist`) is generated, and gitignored where Nx caches it: Nx's file map skips gitignored files, so Nx hashes nothing there (a changed `dist` file is a cache hit under Nx 23.3), and it is dropped without a todo, and the task that writes it keys its dependants through `dependsOn`.

| Option  | Meaning                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `root`  | Directory holding `nx.json`, relative to the workspace root or absolute. Defaults to the workspace root.                                                     |
| `graph` | An exported graph (`nx graph --file=<path>`) to read instead of keeping a snapshot; with it set the plugin never runs `nx`. Relative to `root`, or absolute. |

### Module boundaries

`@nx/enforce-module-boundaries`' `depConstraints` in the root ESLint config become `run.rules.dependencies`, which `vx lock` checks over each project's workspace dependencies, unless `.vx/workspace.ts` sets its own. `sourceTag` is `from`, `onlyDependOnLibsWithTags` is `allow`, `notDependOnLibsWithTags` is `deny`. The config is read, never run, so a flat config's constraints must be a literal array. vx leaves out what it cannot express: `allSourceTags`, a `/regex/` tag, and banned external imports. vx checks package dependencies, not source imports, and lets an untagged project depend on anything.

### `nx:run-commands`

Nx's own option handling, rendered as one POSIX `sh` line (`vx show` prints it):

- **Where:** the workspace root unless `cwd` says otherwise — a `cd` from the project dir, since vx has no per-task cwd — with `{projectRoot}`, `{projectName}` and `{workspaceRoot}` expanded.
- **How:** each command runs in a shell of its own. `commands` run in **parallel** unless `parallel: false` (Nx's default): all start at once, the first failure TERMs the rest and fails the task once they have exited (exit 1, as Nx), and the task succeeds once every command has (nx#28477). With `parallel: false` they run in order and the first failure stops the rest. `commands: []` is a no-op that succeeds (nx#31345).
- **Arguments:** every option run-commands does not consume is appended to each command as `--name=value`, then `args`, then whatever follows `vx run … --` — per command unless `forwardAllArgs` is false (nx#12165). `{args}` takes them in place; `{args.name}` is the value passed after `vx run … --` under that name, else the target's options and `args`, spliced in as text as Nx splices it.
- **An argument replaces its option:** an option the arguments after `vx run … --` name (`--region=us`, `--region us`, `--no-region`, `-r` for a one-letter option; no camel-case expansion) is not appended, as Nx drops it; the line decides once it has them. `tests/nx-run-commands-override-live.test.ts` holds it to `nx run`.
- **Environment:** `env` is `exec.env.define` (so it is in the key), and `color: true` sets `FORCE_COLOR=true`, as Nx does (nx#20465). `envFile` is loaded after the task's `.env` files (below), a name they already set winning, as in Nx (nx#23581).
- **`readyWhen`** makes the task persistent with that string as its `readyWhen`, so dependents start once it is printed; several strings, all of which Nx waits for, run the line under `nx-env --ready-when` (one flag per string), which passes the output through and prints `nx-env: ready` once every string has appeared on stdout or stderr; that line is the task's `readyWhen`.
- **A leading Nx call** (`nx <target> <project>`, `nx run <project>:<target>`, through `npx` / `pnpm` / `yarn` / `bunx` or not) in a serial line, or as its one command, is a `dependsOn` edge to that target (its default configuration, as Nx runs it) and leaves the line: ngrx's `build` opens with `nx build-package <project>`. One Nx would hand options or arguments to, one after another command, and one in a parallel line stay commands.
- **Reported, not reproduced:** per-command `prefix` / `color` decoration, `streamOutput: false`. Decoration in a serial run (`parallel: false`), which Nx refuses, is the failing placeholder with Nx's reason, as `readyWhen` there is. Display-only options (`usePty`, `tty`, `verbose`) change nothing here: vx runs every task without a pseudo-terminal.

`tests/nx-exec-live.test.ts` holds each of these shapes to Nx's own run-commands executor on the same options and arguments.

### Your own executors

A workspace executor that wraps a shell command (a run-commands with your defaults) can be a command instead of an `nx-exec` line, which spares the Node boot each `nx-exec` task pays. Pass `executors` to `nx()`, a function per executor name:

```ts
import { defineWorkspace, type Duration } from '@vzn/vx/config'
import { nx, type NxExecutorTarget } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [
    nx({
      executors: {
        '@acme/tools:run': ({ options }: NxExecutorTarget) =>
          typeof options.command === 'string'
            ? { command: options.command, timeout: options.timeout as Duration | undefined }
            : undefined,
      },
    }),
  ],
})
```

Each function (`NxExecutorTranslator`) gets one target, an `NxExecutorTarget`: `executor`, `project`, `projectRoot` (workspace-root-relative), `target`, `configuration` (set for a `<target>:<configuration>` task) and the resolved `options`. The option's type is `NxExecutors`. It returns an `NxExecutorTranslation`, `{ command, timeout?, env? }`: the command runs in the project dir, `timeout` is `exec.timeout`, a duration with its unit (`'10m'`), `env` is defined as a run-commands `env` is, and the target's `.env` files load as for a run-commands line. Returning `undefined` runs that target through `nx-exec`, as any executor not named. Inputs, outputs (cleaned before each run), `dependsOn` and caching come from the graph as for every target. `nx:run-commands`, `nx:run-script` and `nx:noop` (and their legacy names) are translated by `nx()` itself and are refused here, and so is a return that is not `undefined` or a valid translation. A function's source text keys the cached mapping, so it should depend on its argument alone. `bunx @vzn/vx-migrate` writes executor targets as `nx-exec` lines regardless.

### `.env` files

Nx loads a task's `.env` files into its environment — the project's before the workspace root's, the most specific name first (`.env.build.production.local`, `.env.build.production`, …, `.env.local`, `.local.env`, `.env`), a grouped target's named by its group's owner and parent (cypress's atomized `e2e-ci--a.cy.ts` loads `.env.e2e-ci` and `.env.e2e`), the first to define a name winning and the environment winning over every file — unless `NX_LOAD_DOT_ENV_FILES=false`. `nx()` finds the ones that exist from one listing of each project dir per run (about 4 ms at 1,000 projects) and the task loads them when it runs, with Nx's own parser: a shell line runs under `nx-env --dotenv <file>… --`, an executor line passes `--dotenv <file>` to `nx-exec`. Their values never enter a config, so a `.env.local` secret is not in `vx show`, `.vx/projects.lock.json` or a migrated `vx.config.ts`. A cached task keys on their bytes through a `inputs.runtime` probe (`for f in …; do echo "$f"; cat -- "$f"; …`), which sees a gitignored file a glob would not; a file added or removed changes the command, and so the key, on the next run. `tests/nx-exec-live.test.ts` compares what the line sees with what `nx run` gives the same target.

### The target a task sees

A task whose command still runs Nx or Lerna (`nx-exec`, `nx-env`, `nx exec`, `lerna`) or names one of them gets `NX_TASK_TARGET_PROJECT`, `NX_TASK_TARGET_TARGET`, `LERNA_PACKAGE_NAME` (the project, which Lerna on Nx's runner documents to scripts) and, where it runs a configuration, `NX_TASK_TARGET_CONFIGURATION` in `exec.env.define`, as Nx hands them to every task; a run-commands `env` wins. Any other task gets none. Nx's own `npm:public` / `npm:private` tags are not written. A package script's `nx exec -- <cmd>` reads them: without them it starts Nx's own task runner, which runs the target and its dependencies again.

### Inputs that key nothing here

Nx hashes the root TypeScript config (`tsconfig.base.json`, else `tsconfig.json`) into every task, so every mapped task lists it in `inputs.workspaceFiles`: a `compilerOptions` edit re-runs it, as under Nx. vx keys the whole file, where Nx leaves other projects' `paths` entries out, so a `paths` edit re-runs every task.

`{ dependentTasksOutputFiles }` hashes the outputs of the tasks a target depends on; vx hashes those tasks' keys into it through `dependsOn`, and an output follows from its inputs. A target that reads them with no `dependsOn` edge left to a migrated task (its producer is a project vx did not migrate, such as a .NET project) is written uncached, with a todo naming the producer: its key would see nothing it reads. `{ workingDirectory }` hashes the directory Nx was started from; a vx task runs in its project dir from wherever vx is started. Neither is a todo.

### The environment a task sees

Nx hands every task its whole environment; vx hands a task only its essentials (`PATH`, `HOME`, `CI`, `NODE_OPTIONS`, …), the names its Nx `{ env }` inputs declare (which also key it), and what `nx()` defines (the target, `.env` files, a run-commands `env`). A variable set in the shell and read by no declared input, `NODE_ENV` or `DATABASE_URL`, does not reach the task: declare it as an `{ env }` input of the target in the Nx config.

### Atomized targets

Two cached tasks on one workspace path cannot both keep their cache, and the first declared is kept. Cypress's atomizer gives `e2e` the whole `videos` dir and each `e2e-ci--<spec>` a subdir of it, so `nx()` also tries the split target (a `nonAtomizedTarget`) last and keeps the order that caches more tasks: each spec's CI task keeps its cache and `e2e` runs uncached, with the todo. Where the specs share the split target's one path (jest's coverage dir) the declared order stands.

### nx.json `parallel`

`parallel` (or the legacy `tasksRunnerOptions.default.options.parallel`) is the run's `run.concurrency` when `.vx/workspace.ts` sets none, and `NX_PARALLEL` (a count or `50%`) wins over it, as in Nx: a repo that set `1` for a shared resource ran on every core under vx before.

### nx.json `defaultBase`

`NX_BASE` is the run's base commit (`setBranch({ base })`), and `defaultBase` (Nx 19's `affected.defaultBase` before it, an `origin/` prefix dropped) is `baseBranch` when `.vx/workspace.ts` sets none: a bare `vx run test --affected` compares with the ref `nx affected` does.

### nx.json `maxCacheSize`

`maxCacheSize` maps to nothing: no vx run evicts, `vx cache clean --max-size` does.

### Lerna

`lerna run build` (Lerna 6+ runs it on Nx's task runner) runs each package's `build` after its dependencies' `build`, unless the repo configures Nx's task dependencies: nx.json `targetDefaults` (or the legacy `targetDependencies`), or an `nx` key in the `package.json` of a package that has the target. Beside a `lerna.json` with neither, each target's `dependsOn` is its `^` self (`build` → `^build`), in place of any other, as Lerna hands it to Nx; the exported graph holds no such edge. A migration writes the same.

### Project tags

An Nx project's `tags` are its vx `tags`, so `vx run build --filter tag:scope:web` (or Nx's `--projects tag:scope:web`) selects what `nx run-many -t build -p tag:scope:web` does. A package whose `vx.config` declares `tags` keeps its own. A blank tag is dropped (vx refuses one).

### The graph snapshot

Once per run the plugin keys its snapshot (`<cache dir>/nx-project-graph.json`) on what Nx computes the graph from: `nx.json` and the files its `extends` chain names by content, and the worktree as git sees it — `HEAD`, `git status -uall` (core's own for the run, `DiscoverContext.worktreeChanges`: the tree is walked once, which took ~96 ms per run on refine; a `root` elsewhere asks git itself), and the content of every listed path under a project root (the last graph's too, so a project `discover` names counts before it is one), any `project.json` or `.gitignore` (Nx's project walk honours each one), or at the root (manifests, lockfiles, `tsconfig*.json`). A different key, or no snapshot, runs `node_modules/.bin/nx graph --file=<snapshot>` (or, where the root links no `nx`, a Lerna repo on pnpm, the `nx` Lerna depends on, which `lerna run` runs) — the one time Nx itself runs, served from the daemon when one is up. So a source edit that adds a cross-package `import` (an edge Nx derives) or a config an Nx plugin infers targets from (`vite.config.ts`) re-exports before the run, tracked or untracked, and a touch without an edit, or a stray file a task writes at the root, does not. Outside a git worktree the plugin falls back to the manifests' mtimes. The snapshot and its key live in the cache dir, which ignores itself (a `*` `.gitignore` inside it), so writing them moves nothing. Nx's own caches (`.nx/cache/`, `.nx/workspace-data/`, which the export writes) never enter the key: under a root project (a standalone repo) that does not ignore them, each export re-exported on the next run. An export that fails with a snapshot in hand warns and runs on the previous graph. The snapshot is machine-local, like the cache: nothing about it enters a key. Measured at 1,000 projects: the export runs once (1.5 s with the daemon off after an edit, 0.9 s with it on; Nx's own computation), and a warm run with nothing changed pays the key, 43 ms at min where the manifest stats it replaced took 9 (item 1075), plus the mapping. Under `vx watch` the same rule runs per cycle: a `project.json` edit is the next cycle's tasks, the export included — 1.3 s from the edit to the new command's effect on that workspace. The mapping itself is kept beside it (`<cache dir>/vx-migrate-nx-mapping.json`), keyed on everything it reads — the graph, `nx.json` and its `extends` chain, every package manifest, each project dir's `.env` names, `NX_LOAD_DOT_ENV_FILES`, which bins are installed and the mapper's own code — so a warm run with nothing changed maps nothing.

### What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from the graph.
- Each package-manager member is a project through core's `discover` stage (core finds only directories holding a `vx.config`), named by its `package.json`. An Nx project no workspace package matches — the root project, or an integrated repo's `project.json` library no package glob lists (analogjs) — is made a project the same way, by its `package.json` name or else its Nx name, and its targets attach there by directory; no `vx.config` is needed. One whose name a package already holds, or whose directory is gone, has nowhere to go and is reported by `vx lock`; run its targets with `nx`. A `^target` only such a project declares is no edge, as under Nx, and an explicit edge to one of its targets is dropped with a todo (the key misses it) rather than refusing the run. A negated output (`!{projectRoot}/dist/cache`) takes its path back from the positive ones (core's A-44). A cached target with no `outputs` takes what Nx caches for it: `options.outputPath` (each path of a list), or for `build` and `prepare` `dist/{projectRoot}` and `{projectRoot}/dist`; Nx's `{projectRoot}/build` and `{projectRoot}/public` are outputs too when git tracks nothing under them; one that holds a tracked file is a todo, since vx cleans an output before the run.
- Nx adds an `nx-release-publish` target (`@nx/js:release-publish`) to every project with a `package.json`; it comes along as one `nx-exec` task per package, run only when asked (`vx run nx-release-publish --filter <pkg>`), and counts in `vx info`'s task total. A migration does not write it: Nx release's publish step skips a private package and a published version and rewrites `workspace:` ranges, which no one line does, so the report has one note naming the package manager's own `publish`.
- `nx-exec` and `nx-env` must be on every task's PATH, which they are when `@vzn/vx-migrate` is a devDependency of the workspace (its bins land in `node_modules/.bin`); a plugin loaded by path warns once per run when they are not. Both load Nx from the workspace, so a repo run from an exported `graph` with no `node_modules/nx` warns once too.
- A `dependsOn` entry's `params: "forward"` (the run's arguments) and `options: "forward"` (this target's options, its configuration's merged in) hand the dependency overrides, a different command than vx's one task per target: each is one todo per task, naming no dependency so a run's warnings group them (an atomized `e2e-ci` forwards to every spec), `options` only when there are options to forward.
- Batch executors run one task per process; an executor that reads `context.taskGraph` under `NX_BUILDABLE_LIBRARIES_TASK_GRAPH` sees none and takes Nx's project-graph path.
- The mapping's gaps are the migration's gaps, reported as warnings by `vx lock`, once for all the tasks that carry each one. What this machine lacks to run them (the `nx-exec` bin, `node_modules/nx`, a graph export that failed) is warned on every run too. `bunx @vzn/vx-migrate --dry --from nx` lists the same set once.

## `nx-exec` — one Nx executor, one process

```
nx-exec <executor> --project <name> --target <name> [--configuration <name>] [--options '<json>'] [--dotenv <file>]... [overrides…]
nx-env [--dotenv <file>]... [--envFile <file>] [--ready-when <string>]... -- <command> [args…]
```

`nx-exec` is a bin this package installs, and what `nx()` runs for every executor target. It runs under the workspace's Node (executors are Node programs), resolves `nx` from the working directory up to the workspace's `node_modules`, reads Nx's cached project graph for the `ExecutorContext` executors expect (project root, dependencies for buildable libraries; computed in-process when the cache is missing or lacks the project, as `nx run` computes it, never through the daemon), **replaces** that project's target in the in-memory graph with the executor and options given, and calls Nx's own public `runExecutor`, so Nx's option merging, schema defaults and validation run unchanged. The executor runs from the workspace root, where Nx forks one, though vx starts the task in its project dir: an executor that resolves against `process.cwd()` (@nx/js's ts transformers, prettier's config) sees what it sees under Nx. Anything else on the line — what `vx run <target> -- --otp=123` appends — is an override, parsed by Nx's own `createOverrides` and handed to the executor as `nx run <p>:<t> --otp=123` would (nx#12165). `--dotenv` files are loaded into its environment first (see `.env` files above). The exit code is the outcome `nx run` reports: the executor's returned result when it returns one, else its last yielded result; a server executor keeps the process alive for as long as it yields. A thrown error (an executor's own, or a missing executor package) exits 1 with its message, and its stack only under `NX_VERBOSE_LOGGING=true`, as `nx run` reports one; an executor package that is not installed is one line naming it. The bin enables Node's on-disk compile cache for its own process (Node ≥ 22.1, a no-op below), which takes about 30 ms off every executed task after the first.

`nx-exec` sets `NX_DAEMON=false` unless set (it never dials the daemon), and `NX_VERBOSE_LOGGING=true` is the context's `isVerbose`.

`nx-env` loads the `.env` files and a run-commands `envFile` with Nx's own functions, then runs the command with `sh -c`, whatever follows it appended as vx appends forwarded arguments; its exit is the shell's. With `--ready-when`, the command's stdout and stderr pass through unchanged and `nx-env: ready` is printed once every string has been seen (one split across two writes included).

Why the command carries the options: vx's key sees them (resolved-config hashing holds), no ambient state decides what runs, `vx show` prints the truth and the line pastes into a shell. Each executed `nx-exec` line still loads Nx's own module graph (about 220 ms, on a miss only): it is a bridge, and the bare command that replaces it in native config pays none of that. The design is in `docs/design/nx-unchanged-2026-09.md`.

## `bunx @vzn/vx-migrate` — write the configs

```bash
bunx @vzn/vx-migrate           # auto-detect: turbo.json, .nx/workspace-data/project-graph.json, nx.json or lerna.json, then vite-plus, else package.json scripts
bunx @vzn/vx-migrate --dry     # print the generated files + the report instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
bunx @vzn/vx-migrate --from vite-task # Vite Task beside turbo.json or Nx
bunx @vzn/vx-migrate --from scripts   # package.json scripts beside any of them
bunx @vzn/vx-migrate --native  # write vx.config.ts files without asking
bunx @vzn/vx-migrate --keep    # keep turbo.json / nx.json as the source: turbo() or nx(), with its plugins
bunx @vzn/vx-migrate --help    # the usage, exit 0
```

It is the one command a repo needs (`pbunx @vzn/vx-migrate` in a pnpm repo works the same):

- In a Turbo or Nx repo, in a terminal, it asks which adoption you want: **native** (the default, a `vx.config.ts` per package) or **keep** (a workspace file declaring `turbo()` or `nx()`). `--native` / `--keep` answer it; with no terminal (CI, a pipe) it is native. Elsewhere both are refused. A repo already set up (a workspace file declaring neither, and project configs) is said to be, exit 0, unless `--force`.
- Native or keep, a remote cache the repo shows is declared: `turboCache()` for turbo.json's enabled `remoteCache`, a `turbo link`ed `.turbo/config.json` or a CI file (`.github/workflows/*`, `.gitlab-ci.yml`, `.circleci/config.yml`) setting `TURBO_TOKEN`; `nxCache()` for one setting `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`. The report names the file that showed it. Nx Cloud (`nxCloudId`, `nxCloudAccessToken`, the `nx-cloud` runner) is named instead: vx does not speak its wire.
- With no `.vx/workspace.*` yet, it writes one declaring the plugins the repo calls for (`src/workspace-plugins.ts`): the remote cache above, the `@vzn/vx-lockfile` factory for the lockfile (`bun()`, `pnpm()`, `npm()`, `yarn()`), `vxHistory()`, and `github()` when `.github/workflows` exists and `gitlab()` when `.gitlab-ci.yml` does, from `@vzn/vx-ci` (a remote cache on CI reads the refs they name), each installed beside `@vzn/vx` at vx-migrate's own version. Keep adds them to the file it writes, or to one already in that shape; any other workspace file is the user's and left alone. Native over a file vx wrote (a keep adoption's) rewrites it: `turbo()` and `nx()` go, since the configs written replace them, and the other plugins stay.
- It installs what the written files import with the repo's own manager (`packageManager`, else the lockfile): `@vzn/vx`, every `@vzn/vx-*` package the workspace file imports (one an earlier init wrote included), and `@vzn/vx-migrate` for keep or when a written task runs its `nx-exec` or `nx-env` bin (`pnpm add -D -w` in a pnpm workspace and without `-w` in a lone package, `yarn add -D -W` on Yarn 1 and without `-W` on Yarn 2+, `bun add -d`, `npm install -D`). A package the root both lists and has installed at vx-migrate's own version is left alone; any other is installed at that version, and so is every other `@vzn/vx-*` plugin the root lists from the registry (one install moves them together, as `vx upgrade` does). Native removes a listed `@vzn/vx-migrate` when nothing written needs it (no `nx-exec` / `nx-env` task, no `turboCache()` or `nxCache()` left in the workspace file): `pnpm remove` (`-w` in a pnpm workspace), `yarn remove` (`-W` on Yarn 1), `bun remove`, `npm uninstall`. `--no-install` skips both. An install or removal that fails does not stop the migration: the manager's output prints, the report's `failed` row names the command, the files are still written, and vx-migrate exits 1. vx-migrate runs only with the `@vzn/vx` of its own release, which it installs: one of another release (a `bun x` install directory keeps the one it had) is refused, naming where it was loaded.
- Native, once the files are written, it ends with `vx lock`: `.vx/projects.lock.json` is written and the graph rules are checked, its line the report's `lock` row. A refusal prints above the report and the configs stay written (exit 0). `--no-install` skips it, since the plugins the workspace file declares are not installed yet, and `next` then starts with `vx lock`.

A Lerna repo is an Nx one: Lerna 6+ runs `lerna run` on Nx's task runner over the graph `nx graph` exports, nx.json or not, so a `lerna.json` with no nx.json and no turbo.json is mapped from that graph, and keep writes the workspace file declaring `nx()`. Lerna is the installed one, else the root manifest's range; with neither, the lerna.json is another tool's (lerna-lite reads it too, and runs no Nx). A root whose scripts never `lerna run` runs its tasks another way and publishes with Lerna (webdriverio: `run-s`, `pnpm -r`), so its scripts stay the source. Not where Lerna runs its own runner: `useNx: false`, or Lerna 5 without `useNx: true`; those map their scripts. Beside turbo.json, Turbo runs the tasks and Lerna only publishes: turbo.json is the source.

Your `package.json` scripts are never edited. `--dry` installs nothing and says what it would install.

`--dry` prints the files instead of writing them; `--force` overwrites existing ones; `--mjs` writes `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts` — the same objects with no type import and no `satisfies`, for a package whose own `tsconfig` includes every `.ts` under it and would compile the config into its dist (TanStack/query, 2026-09-11).

Every source hands a plan to core's `applyMigration` from `@vzn/vx`), which renders, refuses to overwrite without `--force`, writes and reports. Anything a source cannot say becomes a `TODO(vx-migrate)` comment, never a silent wrong value.

The report reads like a run's footer: a blank line, the `─ vx-migrate <version> ───` rule, then one dim label per row and each fact once: `from` (the source), `ran` (each install or removal command), `tasks` (clean in green, todo in yellow), `todo`, `files`, `kept`, `replaced`, `lock`, `note`, and last, after a blank line, `next` in bold. A terminal sees the install command while it runs, on a line the report replaces; the manager's own output prints only when it fails.

### Turbo

Reads the root pipeline (`tasks` in Turbo 2, `pipeline` in Turbo 1), per-package `turbo.json` `extends` overlays and each package's scripts, through the same mapper `turbo()` runs live — so the written configs say what the plugin was doing. Turbo's global fields become a generated root `vx-preset.ts` each config imports and spreads: TypeScript composition replaces global config. A config that a `tsconfig*.json` in its directory or above (below the root) takes in, where that project is composite or sets `rootDir`, declares the values it uses instead: `tsc` refuses a file outside the package (TS6059, TS6307; withastro/astro's `scripts/` and the `performance/` project its `packages/astro/tsconfig.test.json` takes in). So does a task's `env` that several configs share (`buildEnv`), where inline it would repeat in every package (vercel/ai: 63 names, twice in each of ~100 configs, half the output). Turbo's `//#` root tasks are written to a `vx.config.ts` at the workspace root, which makes the root a project (core's D-39), and a package task's `//#x` edge reaches it. When a `.vx/workspace.ts` already exists without one, the report names the `@vzn/vx-lockfile` plugin for the repo's lockfile: Turbo keys each package on its own lockfile entries, and core keys every task on the whole file until a plugin owns it.

| Turborepo                           | vx                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `dependsOn`                         | `dependsOn`, same micro-syntax (`$TURBO_ROOT$` deps are a TODO)                                                                |
| `inputs`                            | `inputs.files` (`$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/x` → `workspaceFiles`)                                               |
| `outputs`                           | `cache.outputs.files`, a negated one included                                                                                  |
| `env`                               | `inputs.env` **and** `exec.env.passThrough` (child envs are isolated)                                                          |
| `passThroughEnv`                    | `exec.env.passThrough`                                                                                                         |
| `cache: false` / `persistent: true` | no `cache` block, still keyed on its `inputs`; `exec.persistent: {}`, with a TODO to set `readyWhen` when a task depends on it |

### Nx

Reads the **resolved** project graph only (`.nx/workspace-data/project-graph.json` when exported, else the one the workspace's own `nx graph` exports into a temp file, as `nx()` does; with no `node_modules/.bin/nx`, as in a fresh clone, it stops and names the repo manager's install), through the same mapper `nx()` runs live, executors aside (below). Targets Nx plugins infer at runtime are frozen as the snapshot saw them. `nx:run-commands` is the one shell line `nx()` runs (see [`nx:run-commands`](#nxrun-commands) above: where, parallel or in order, forwarded arguments, `env`, `readyWhen`) — storybook's `compile` is `cd ../../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli`; a plain `command` is that shorthand; `nx:run-script` is the package's script body with its `pre<name>` / `post<name>` hooks joined in (or `yarn run <name>` when the body calls yarn's `run` builtin; an empty script is the placeholder with a todo), `nx:noop` is a group task; Nx 15–16's `@nrwl/workspace:run-commands` and `run-script` (and their `@nx/workspace:` names) are the `nx:` executors they re-exported; **an executor target is its `nx-exec` line**, as `nx()` runs it: the migrator translates no executor, so Nx and `@vzn/vx-migrate` stay installed until each such line is rewritten as the command it runs (a server executor Nx knows, `@nx/js:node` or a dev server, is still a persistent task). The report also says what `.vx/workspace.ts` still holds, as the Turbo migration does: the `nx()` a keep adoption declared, which keeps reading nx.json, and a lockfile with no `@vzn/vx-lockfile` plugin, where Nx keyed each project on the npm packages it depends on. A written command that still runs Nx itself (a run-commands `nx run b:build`, `npx nx test b`, a script's `nx exec -- tsc`) carries a TODO: it works only while Nx is installed. An Nx project no workspace glob lists (an integrated repo's `project.json` library) gets a `package.json` (`name`, `private`) where it has none, and a note names the directories to add to `workspaces` (or `pnpm-workspace.yaml`), so the package manager installs it and a lockfile plugin names it; the migrator never edits the root manifest. A repo with no `package.json` at all (Nx's `nx init` outside JS: Nx pinned in `.nx/installation`, projects as `project.json`) is migrated too, natively only: the root is the directory holding `nx.json`, the graph is exported by `.nx/installation`'s `nx`, each config writes the project's Nx `name`, every edge is the explicit `project#target` Nx's graph draws (a `^` edge needs a lockfile plugin, which has no lockfile to read), and `.vx/workspace.ts` declares no plugin, so nothing is installed and core runs the configs alone; `--keep` refuses, as `nx()` would have no `package.json` to install into, and an executor target's `nx-exec` line is a note to rewrite as a command. A target with `configurations` writes one task per configuration (`build`, `build:ci`). A project's Nx `tags` are written as its `tags`. Named inputs expand from `nx.json` when readable. An output path is kept as written, a `!` one too (`{projectRoot}/dist` → `dist`, `{projectRoot}/bin/tool` → `bin/tool`; one naming an unset `{options.x}` is dropped, as Nx drops it; a dotted `{options.outputPath.base}` walks the options, as Nx does; an extglob is put in vx's grammar: Next's inferred `.next/!(cache)/**/*` is `.next/*/**/*` with `!.next/cache/**/*`, `@(js|map)` is `{js,map}`, Nx's bare group `*.(js|map)` is `*.{js,map}` in inputs and outputs alike, and a form with no vx spelling is dropped with a TODO; a `**` glued to text, in an output or an input, is one `*` as Nx reads it, `src/**.ts` → `src/*.ts`): vx reads a bare path as the file or the whole tree under it, so a directory and an extensionless binary both save and restore. nx.json's `parallel` and `defaultBase`, which `nx()` applies live, are each a field of the `.vx/workspace.ts` it writes (`run.concurrency`, `baseBranch`), read from nx.json alone, never the environment; beside a workspace file already there, each is a note naming the field to add. vx derives package edges from `package.json`; an Nx graph edge with no manifest path (`implicitDependencies`, a tsconfig path) becomes, for each `^target` of the dependant, an explicit `pkg#target` edge to what Nx's own walk reaches — each dependency that has the target, and through one that lacks it, its dependencies — so the order and the key are Nx's. The reverse too: where a project's manifest names a workspace package its Nx graph does not reach (an `implicitDependencies: ["!a"]` that breaks a manifest cycle), its `^target` becomes the explicit edges Nx draws, since vx's `^` would follow the manifest and bring the cycle back.

### Vite Task

Detected when the root `package.json` lists `vite-plus`, after turbo.json and Nx: vite-plus is a whole toolchain, so a repo with either of those runs its tasks there; `--from vite-task` picks Vite Task anyway. There is no live plugin, so `--keep` is refused. Each package's `vite.config.*` (vite-plus's file order) is loaded by Bun as `vp run` sees it, a function config called in build mode, and its `run` block mapped with the package's `package.json` scripts, which `vp run` runs too. The root package's tasks and scripts (`vp run -w`) make it a project when it has a `name`. A command that opens with `vp run` (or `vpr`) is inlined as Vite Task inlines it: `vp run x`, `pkg#x`, `-r x`, `-w x` and `-F <name> x` are `dependsOn` edges (`-r` to each package with `x`, the task's own reference pruned), and the task is a group when nothing follows them. They run in parallel where Vite Task ran a chain in order; any other form (`--parallel`, `-t`, forwarded arguments, a `vp run` after another command) stays in the command with a TODO.

| Vite Task                                                 | vx                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` (a string, or an array run in order)            | `exec.command`, the array joined with `&&`; `command: []` is a group task                                                                                                                                                           |
| `cwd`                                                     | `cd <cwd> && ` before the command                                                                                                                                                                                                   |
| `dependsOn: 'x'` / `'pkg#x'`                              | the same                                                                                                                                                                                                                            |
| `dependsOn: { task, from }`                               | `^task`; when a member listed under a field `from` leaves out also has the task, the explicit `pkg#task` edges, since `^` follows every field                                                                                       |
| `cache.input` / `cache.output` globs                      | `inputs.files` / `cache.outputs.files`; `base: 'workspace'` → `workspaceFiles`, a root task's too; a `**` glued to text (`src/**.ts`), which wax refuses, widens an input to `**/*` and runs an output's task uncached, with a todo |
| omitted or `{ auto: true }` (traced files)                | no `cache` block, with a TODO: vx infers no inputs or outputs                                                                                                                                                                       |
| `cache.env`                                               | `inputs.env` **and** `exec.env.passThrough`; a `*` entry lists the names the package's tracked files and its workspace dependencies' spell (a TODO when none match); `!` entries take names back                                    |
| `cache.untrackedEnv`                                      | `exec.env.passThrough`, wildcards as `cache.env`                                                                                                                                                                                    |
| `cache: false`, root `run.cache` `false` / `tasks: false` | no `cache` block                                                                                                                                                                                                                    |
| a `package.json` script                                   | a task, uncached; with root `run.cache.scripts` a TODO for its cache                                                                                                                                                                |
| `run.enablePrePostScripts` (default `true`)               | a script's `pre<name>` / `post<name>` joined into its command; `false` keeps them tasks of their own                                                                                                                                |

### package.json scripts

Where no runner's config is the source (or under `--from scripts`), each
package's `package.json` scripts become its `vx.config.ts`, plus a
`.vx/workspace.ts` that declares the `@vzn/vx-lockfile` plugin for the lockfile at
the root (`bun()`, `pnpm()`, `npm()` or `yarn()`; `{ plugins: [] }`
without one): package edges (`^build`, `--affected`) come from it.
vx runs and caches on this machine with no plugin, so it declares no executor or
cache, and the file carries no comment (it is the user's). When
`@vzn/vx-lockfile` is not installed, it installs it with that manager,
pinned to its own version, before `vx lock` runs (`--dry` names the
command instead). A workspace file already there is left as it is. A workspace with no scripts at
all still gets the workspace file, a printed example config, and the
next command to run. A root
`package.json` with no `workspaces` field is single-project mode, and
when `packages/*/package.json` files sit below it unreached, both
the mapper and a run that finds no config say so instead ("package.json
declares no workspaces … Add "workspaces": ["packages/*"] to
package.json and re-run") rather than "no scripts" or "run vx init". A
workspace whose globs match no `package.json` gets a note naming them
(M-42); a nameless member, or two sharing a name, is matched and
named on its own line instead (M-46). When such skipped scripts are all there
is, the report's `tasks` row reads `none: no package.json script became a task` rather than
saying there are none (M-59). When `pnpm-workspace.yaml` lists the
members and the root `package.json`'s `workspaces` lists other globs,
the note names the unread list (M-51): pnpm reads only the yaml, while
bun, npm and yarn read `package.json`. With
no `package.json` or `pnpm-workspace.yaml` here or above, it stops and
names `vx init`, which sets up a workspace without one. Every
generated config is typed for the editor through
`import type { ProjectConfig } from '@vzn/vx/config'` and `satisfies
ProjectConfig` — a type-only import Bun erases, so the file loads in a
workspace that runs the `vx` binary without the package installed. The
workspace file takes the same form (`satisfies WorkspaceConfig`). A
runtime `import { defineWorkspace } from '@vzn/vx'` costs nothing extra
since 2026-09-10: the running `vx` serves its own core to that
specifier (bin.ts registers the alias), so a config or a plugin package
never loads a second copy, and a workspace that runs the binary needs
no `@vzn/vx` installed for it — the type-only form is still what the
scaffold writes, because it types the same with no import to resolve
in an editor without the package. A workspace that imports a PLUGIN
package at runtime without having installed it is told so, and to
install its dependencies. `--mjs` writes the same objects as `vx.config.mjs` and
`.vx/workspace.mjs`, with no type import and no `satisfies`: a package whose
own `tsconfig` includes every `.ts` under it compiles a `vx.config.ts`
into its dist (TanStack/query's `tsc --build`, 2026-09-11), and an
`.mjs` is outside that include.
A file it writes that `.gitignore` drops (vueuse ignores
`packages/**/*.mjs`) gets a `note:` naming it and the `!vx.config.mjs`
line that keeps it, since a commit would leave it behind unnoticed.
When a whole directory is ignored, such as the old layout's `/.vx/`
cache line now hiding `.vx/workspace.ts` and the lock, the note names
that directory instead: git re-includes nothing inside an ignored
directory, so no `!` line helps. vx never edits `.gitignore`.
A package with a `tsconfig.json` and no `"type": "module"` gets
`vx.config.mts`: tsc (node16, nodenext) reads a `.ts` there as
CommonJS, and its type import of the ESM `@vzn/vx/config` fails
(TS1479, TS1541: medusa's plugin builds, 2026-10-14); an output that
takes the config back names the `.mts`. The files written
then go through the repo's own formatter when its root installs one
(`prettier --write`, `biome format --write`, `oxfmt` or `dprint fmt`,
the first found), and a `note:` says so: create-t3-turbo's `prettier
--check` failed on the quotes of a written config. A formatter that
fails leaves the files as written and the note names its error.

Each script becomes a task with its command verbatim. `build` gets
`dependsOn: ['^build']` (a `build` that only delegates, `pnpm run
compile`, is a group, and the edge goes on the script that does the
work) and **no cache block** — under a
`TODO(vx-migrate)` showing the block to add with the package's real
inputs and outputs, and the same block commented as the task's first
line: set the real globs and delete the `// `. A task without a cache block always runs; a block
with EMPTY outputs is not "uncached" but a no-output task that hits on
unchanged inputs and skips the build with nothing to restore (a deleted
`dist` stays deleted under a green `up-to-date` run — what `vx init`
generated until 2026-09-04), and a guessed `dist/**` would restore the
wrong tree for every package that writes elsewhere. The block the TODO
shows names `dist/**`, or the default output of the framework the command
runs: `.next/**` minus `!.next/cache/**` for `next build`, `.output/**`
for Nuxt, `build/**` for Remix, React Router, Create React App and
Docusaurus, `public/**` for Gatsby, `storybook-static/**` for Storybook;
for any other command, the directory it names with `--outDir` / `--out-dir`
/ `-d`, else the ones it cleans first (`del-cli distribution`, `rimraf lib
types`), unless it makes one again with `mkdir` (D-90).
A package in a cycle of builds (nuxt's `@nuxt/nitro-server` devDepends
on `nuxt`, which depends on it; pnpm sorts it away) gets, instead of
`^build`, an edge to each build outside its cycle that `^build` would
reach, and a TODO to order the cycle: `^build` there refuses the run.
A script that runs a workspace package's bin the package gets only
through the root's dependencies (vite's playgrounds run `vite` from the
root's `vite: workspace:*`) also waits on that package's build
(`vite#build`): no `^build` edge reaches it.
`test` / `typecheck` wait for
`build` when the package has one (`lint` reads sources and gets no
edge); `dev` / `start` / `serve` / `watch` /
`preview` become persistent tasks, with a TODO to add `readyWhen` when
another task depends on one, and so does a watcher: a `watch` segment in the script's name (`build:watch`),
a `--watch` flag, `tsc -w` / `rollup -w`, or nodemon (D-40), and a server:
`serve <dir>`, `http-server`, bare `vite`, a tool's `dev` / `serve` /
`start` / `preview` verb (`next start`, `netlify dev`), or a script that
runs such a script of its package by name (`cross-env X=1 pnpm start`) or
through a runner (`run-p web api`, `concurrently "npm:web" "npm:api"`, D-113),
outside quotes and not sent to the background with `&` (D-91), read past
a launcher's `--package <name>` / `-p <name>` (`pnpm dlx --package
netlify-cli netlify dev`, D-112). A
script whose name no task may carry (`lint#fix`, `^up`; the schema's
rule, item 1000) is left out with a TODO rather than written into a
config every later command refuses; a Turbo task, Nx target or Vite Task
task of such a name is too, under `turbo()` and `nx()` as well as in the
written configs, and a `__proto__` script is written
as a computed key, since a literal `__proto__:` sets the prototype. An
existing `.vx/workspace.*` in any extension the loader reads (`.mts`
included) is kept, and `--force` REPLACES a package's config of another
extension (`replaced` in the report) rather than writing a second one
the loader would choose between by its order (item 1033). Without
`--force`, it never overwrites: a package that already has a vx
config keeps it, untouched, the rest get theirs, and the report lists
the kept ones under `kept`, so a half-adopted workspace adopts the rest
(M-52). A Turbo, Nx or Vite Task migration still refuses an existing config.

Two npm conventions are mapped rather than copied, because copying them
loses behaviour. `pre<x>` / `post<x>` hooks, which npm runs around `x`
without being named, are joined into `x`'s command in that order, each
in its own subshell, so the chain stops at the first that fails whatever
a part holds (a `;`, an `exit`), and forwarded `--` args reach `x` alone,
as npm hands them to the script and not its hooks (item 905), appended
as text, so no part sees them as `$1` (X-60). The
command is a small shell function, `vx_script`, around the three parts;
it carries a TODO saying so; a `pre<x>` with no `x` stays a task of its own, and
npm's lifecycle hooks (`prepack`, `prepublishOnly`, …) are never tasks.
Every project gets a `vx.config.ts` (2026-10-14): a member with
no script to run (none, or only lifecycle hooks: a types-only or config
package), or with none a Turbo or Nx repo runs, gets one declaring
`tasks: {}`. A project that already has a config keeps it. A package with no `build` script whose `prepack`, `prepublishOnly`,
`prepublish` or `prepare` runs a builder (`bob build`, `tsc`, `tsup`, …)
is named in the report, which says to add a `build` script running it
(react-navigation's twelve packages, whose root `build` is `lerna run
prepack`, mapped with no build at all).
Where the package's manager runs no such hooks every `pre<x>` and
`post<x>` is a task of its own: Yarn 2+ (the nearest `packageManager:
yarn@2+`, or a Berry `yarn.lock`, D-31; a `packageManager` naming none of npm,
pnpm, yarn or bun defers to the lockfile, D-96), npm under `ignore-scripts=true`
in the `.npmrc` beside its lockfile, pnpm under
`enable-pre-post-scripts=false` there or `enablePrePostScripts: false` in
`pnpm-workspace.yaml` (D-33). Bun and Yarn 1 run them whatever those say.
Under Yarn 2+ a segment's `run <script>`, Yarn's shell builtin, is written
`yarn run <script>`: vx's shell has no `run` (D-92).
A Yarn 2+ repo on Plug'n'Play (no `nodeLinker: node-modules` or `pnpm` in
`.yarnrc.yml`) keeps its bins in `.pnp.cjs`, where vx's PATH finds none;
the report says so and names `nodeLinker: node-modules` or `yarn exec
'<command>'` (D-108).
A script reading `$npm_package_version`, `$npm_package_name` or
`$npm_lifecycle_event`, which every manager sets and vx does not, gets
them under `exec.env.define`, the first two read from an imported
`package.json` so a version bump reaches them; any other `$npm_*` it
reads gets a TODO (D-34). Among several packages, a workspace root
script that runs the members (`pnpm -r build`, `--filter`, `-C`, pnpm's `pn` alias
included (D-97), Yarn's
`--cwd` and `yarn workspace <name>`, npm's `--prefix`, npm's
and Yarn's workspace flags, a `cd` into or above a member, turbo, nx, lerna, `vp run`, vx itself) is not mapped
(a flag counts on the package manager, or after `node <bin> run`, and not on the program it
runs: berry's `yarn node -r ./setup.ts` is node's `--require`, D-81; bun's
`cd test && …` enters no member, D-83),
nor is one that runs such a script by name (vite's `ci-docs`: `pnpm build &&
pnpm docs-build`; through `run-s` / `run-p` / `npm-run-all` or `concurrently
"npm:x"` too, lexical's `ci-check`, D-95), and neither is one whose name a member's task carries, so `--all` never runs
a check twice (D-45). The rest check the whole repo (`lint: oxlint .`,
`test: vitest`) and become the root's own tasks in a root vx.config, when
the root has a `"name"` (vx skips a nameless root's config) and no config
of its own; one already there, hand-written or from an earlier
`vx init`, stays as written, `--force` included, and is listed under
`kept`. The report names each script left out and why
(a `pre` / `post` hook goes with its script, D-85), its examples of running
the members spelled by the repo's manager (`--workspaces` under npm, `yarn
workspaces foreach` under Yarn 2+), and says which;
with nothing mapped it names the root whenever it has a script, a member
or not (pnpm's root is not), and why: its scripts run the workspace, or
share a member's task name (listed), or both; it tells a root with no `"name"` to add one
first (vuejs/core), naming the scripts that would then map (react, D-87), and a root whose
`"name"` a member also carries to rename it, since a root config would make the
workspace refuse every run for the duplicate (insomnia, D-129). A single-package repo's root is its project and maps.
A lone root beside a `lerna.json` (Lerna-classic: packages listed there, not
in `workspaces`) gets a note naming the `workspaces` globs to add, Lerna's
`packages/*` default when it lists none (D-111).
A member whose package.json has no `name` is no project; one with a
script is named in the report, to be given a name (remix's
`packages/component/bench`, D-106).
A member's script that runs another member's work (`pnpm -C ../pinia
run build`, `yarn workspace <name>`, `-r` / `--filter`, a `cd` or `-C`
/ `--cwd` / `--prefix` into another member) keeps its command and gets a
TODO naming that part: the graph runs that member's task once, so name it
under `dependsOn` and drop it from the command (pinia). A directory inside
the member or the root is no other member.
A script that is nothing but `npm run <other>` (`pnpm <other>`, `yarn
<other>`, `bun run <other>`, `npm test`, `npm start`, `npm stop`, and the
aliases `npm run-script` / `rum` / `urn`, `npm t` / `tst`, `pnpm
run-script`, `pnpm t` / `tst`) becomes a **group**
over `<other>` — `dependsOn` and no command — so the graph runs and
caches the target instead of a package-manager subprocess it cannot
see. When `build` is such a group, the task it reaches that runs a
command takes `^build` and the cache TODO, since a group has nothing
to cache; it and the groups on the way drop the wait on `build` a
`typecheck` or `test` would carry, since they are the build (D-16). Bare, a package manager's own command is not a script: `bun test`
is Bun's test runner, `bun build` its bundler, `pnpm install` and `yarn
add` the managers' verbs, so each stays a command (item 908), and so do
the names each manager reserves or hands on: `pnpm docs` and `pnpm
version` (npm's), `bun deploy`, `yarn check` (D-32); `pnpm test`, `yarn
test` and `bun lint` do run the script. Arguments, flags or a `&&`
chain make it a real command again and
it is left verbatim, and so is one whose target becomes no task (a
lifecycle script, or a hook joined into another script): a group over
it would name a task nothing defines (D-12). A verbatim chain whose
parts run this package's own scripts (`check: pnpm run build && pnpm run
lint`) gets a TODO naming those parts: each ran again inside the command,
beside its own task, so `vx run check` built twice (M-41). So does a
part that runs them through `run-s`, `run-p` or `npm-run-all`
(`build: run-p build:*`), unless the task is persistent (M-48). Its
order may matter, so it is not made a group.

The report lists each TODO once per reason: tasks that share one are
named together (the first five, then a count; the files carry each),
and when no task caches it says uncommenting a TODO task's cache line
makes the second run a hit. Its `next:` line is a command the user can type,
with a bare `vx` (`vx init` installs it). Outside a git work tree it starts with
`git init`, and with no script mapped with declaring a task, since the
run would refuse without either. It runs `build`, else the first task that
neither serves (`persistent`) nor changes the repo (`clean`, `release`,
`publish`, `deploy`, `version`, `format`, `fix`, …), else the first task
(react-navigation was told `vx run clean --all`).

### Errors reading the members

The root a migration starts from and its members are the package manager's (`src/packages.ts`): the nearest `pnpm-workspace.yaml`, or `package.json` with `workspaces`, that lists the directory it runs in. What it refuses:

| Symptom                                                                                                      | Cause                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to parse <file>: <why>`                                                                              | A `package.json` / `pnpm-workspace.yaml` is not valid.                                                                                                                                                                                                     |
| `<file>: packages must be an array of glob strings`                                                          | `pnpm-workspace.yaml` `packages:` is a bare string, etc.                                                                                                                                                                                                   |
| `<file>: must be a JSON object`                                                                              | A `package.json` (the root's or a member's) is `null`, a list or a scalar; it crashed with a TypeError until item 988.                                                                                                                                     |
| `<file>: "name" must be a string with no surrounding whitespace`                                             | A `package.json` `name` is a number, an object, or has surrounding whitespace (npm refuses one too); `{"name":123}` planned `123#build` until item 988.                                                                                                    |
| `<file>: "name" cannot hold "#" — vx addresses a task as <name>#<task>`                                      | A `package.json` `name` holds `#` (npm refuses one too): `{"name":"a#b"}` planned `a#b#build` under `--all`, but `vx run a#b#build` and a `dependsOn` split at the first `#` and found nothing.                                                            |
| `<file>: must be a mapping (packages: and pnpm's settings)`                                                  | `pnpm-workspace.yaml` is a list or a scalar. A mapping with no `packages:`, or an empty one (pnpm 10 settings or catalogs in a single-package repo) is not an error: the root's `package.json` decides, as without the file (item 984).                    |
| `<file>: workspaces must be an array of glob strings`                                                        | `package.json` `workspaces` holds a non-string entry.                                                                                                                                                                                                      |
| `workspace member <dir> (<abs>) is outside the workspace root <root>: vx keeps every project under the root` | A member glob (`../ext/*`, an absolute path) reached a package outside the root. npm and pnpm take one; `--affected` asks git from the root and missed edits there. Move the root up to a directory that holds every member.                               |
| `<file>: workspaces.packages must be an array of glob strings`                                               | The yarn-legacy `workspaces: { packages: [...] }` form holds a non-string entry.                                                                                                                                                                           |
| `<file>: <field> entry "<glob>" is an extglob, which vx's glob engine does not read`                         | A member glob holds `!(…)`, `@(…)`, `+(…)`, `*(…)` or `?(…)`. `Bun.Glob` has no extglob (its scan widened `packages/!(x)` to include x, turborepo#3766); a whole-segment `!(a\|b)` gets its exact rewrite, `["packages/*", "!packages/a", "!packages/b"]`. |

## `turboCache()` — a Turbo remote cache

Store vx artifacts in any server speaking Turbo's `/v8/artifacts` API — Vercel's hosted cache or a self-hosted implementation of the published OpenAPI spec (Bearer auth, `x-artifact-duration`, HMAC-SHA256 `x-artifact-tag` signatures). The wire is theirs; the bytes are vx's own artifacts under vx's own keys. The server is storage — the other tool cannot read what vx stores there, and vx does not read its entries.

Nothing is on by default. Declare the plugin in `.vx/workspace.ts` and configure it explicitly. Reads try the local cache first and the remote only on a local miss:

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [
    turboCache({
      url: 'https://cache.example.com',
      token: process.env.CACHE_TOKEN,
      teamSlug: 'acme',
      // Optional: sign uploads and verify downloads (Turbo's artifact signature).
      // signatureKey: process.env.CACHE_SIGNATURE_KEY, teamId: 'team_acme',
    }),
  ],
})
```

Off CI a run reads the remote and does not write it unless its policy names the remote. Give the write token only to the default branch's CI and a read-only one to laptops and pull request jobs: the server's token is the boundary (`docs/security.md` § Cache poisoning). The same holds for `nxCache()`.

Every option falls back to the tool's own environment variable, so a self-hosted setup carries over unchanged. An empty variable is unset, as Turbo reads it. A token with no URL means Vercel's hosted Remote Cache (`https://vercel.com/api`), exactly as it does for `turbo` — so `bunx turbo login && bunx turbo link`, then `turboCache()` with `TURBO_TOKEN` / `TURBO_TEAM` set, is the whole hosted setup. Below the environment, in Turbo's order: a Vercel build's `VERCEL_ARTIFACTS_TOKEN` and `VERCEL_ARTIFACTS_OWNER` (the team id, where `TURBO_TOKEN` with a team is not set), then the repo's `.turbo/config.json` (what `turbo link` writes: `apiUrl`, `teamId`, `teamSlug`, `token`), then the root `turbo.json`'s `remoteCache` (`apiUrl`, `teamId`, `teamSlug`), whose `enabled: false` declines unless the options name a cache. A team with no URL also means Vercel's. With a URL or a team but no token, the token comes from the OS keychain ([Tokens](#tokens-and-the-os-keychain)); with none of the three the plugin **declines** and the run stays local.

| Option            | Environment variable                                                                                              | Meaning                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `TURBO_API`                                                                                                       | base URL of the cache server; default with a token: `https://vercel.com/api`; http(s) only (http to any host, as Turbo and Nx take it); a `user:pass@` in it is refused, the option's when the config loads                                                                                           |
| `token`           | `TURBO_TOKEN`                                                                                                     | Bearer token on every request; then OIDC, `.turbo/config.json`, the OS keychain                                                                                                                                                                                                                       |
| `oidc`            | `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` (GitHub sets them)                               | `true` or `{ tokenUrl, revokeUrl, audience, params }` (`TurboOidcOptions`): exchange the GitHub Actions job's OIDC token for a short-lived one ([OIDC](#oidc-on-github-actions))                                                                                                                      |
| `teamId`          | `TURBO_TEAMID`                                                                                                    | `teamId` query parameter (Vercel's `team_` form only, as Turbo sends it); part of the signature                                                                                                                                                                                                       |
| `teamSlug`        | `TURBO_TEAM`                                                                                                      | `slug` query parameter                                                                                                                                                                                                                                                                                |
| `signatureKey`    | `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, read only under turbo.json's `remoteCache.signature: true`, as Turbo reads it | HMAC-SHA256 key, used raw, over the team id (`''` without one, as in Turbo); the option needs ≥ 32 bytes, the env key warns below that unless `futureFlags.longerSignatureKey` refuses it; signing on with no key turns the remote off with a warning; a download whose tag does not verify is a miss |
| `timeoutMs`       | `TURBO_REMOTE_CACHE_TIMEOUT`, then `remoteCache.timeout` (seconds)                                                | HEAD/GET/POST deadline (default 30 s; 0 none); the option is ms up to 2³¹−1 (the longest a timer holds), the variable and file are held to it                                                                                                                                                         |
| `uploadTimeoutMs` | `TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT`, then `remoteCache.uploadTimeout` (seconds)                                   | PUT deadline (default 60 s; 0 none), bounded as `timeoutMs`                                                                                                                                                                                                                                           |
| `retries`         | —                                                                                                                 | resends of a request answered 5xx (not 501) or never connected (default 1, Turbo's); a 429 waits out the limit; 0 turns both off                                                                                                                                                                      |
| `preflight`       | `TURBO_PREFLIGHT` (1 or 0), then `remoteCache.preflight`                                                          | send Turbo's `OPTIONS` preflight before each artifact request and go where its `Location` points (relative to the URL); the token goes along only when the API's `Access-Control-Allow-Headers` admits `Authorization`; a redirected preflight is not followed (default off)                          |
| `scope`           | —                                                                                                                 | `RemoteScope`: `'header'` (default): every read names the run's refs, own branch first, in `x-artifact-read-scopes`; `'key'`: each entry is keyed on its ref, a read asks every ref's key in one batch (a server that ignores the header)                                                             |

The signature is Turbo's current scheme (`artifact-signature:v2`: prefix, hash, team id and body, each length-prefixed, under HMAC-SHA256, base64 in `x-artifact-tag`). A signed body is written to a temp file before its tag can be checked, so one past core's artifact ceiling (2 GiB, at zstd's bound) is refused as it passes it, and is a miss.

Artifacts stream both ways on both wires: an upload sends the local artifact from its file, a download hands vx the response body to write straight to disk. A signed download must verify before vx sees a byte, so it is written to a temp file in vx's cache directory (which the sandbox walls, unlike the shared temp dir a sandboxed task may read) and verified from there (the tag covers the body's length, which a chunked response does not declare up front); a bad tag deletes the temp and reads as a miss, and a good one is handed over as a stream that deletes the temp once it is read or cancelled. A process that exits first (vx's Ctrl-C exit awaits no stream) deletes it on the way out.

## `nxCache()` — an Nx self-hosted remote cache

Store vx artifacts in any server implementing Nx's remote cache OpenAPI spec (`GET`/`PUT /v1/cache/{hash}`, Bearer auth, immutable records — a second write of a hash is `409`, which the plugin treats as done). Same rule: the wire is theirs, the bytes are vx's. A download asks for `Accept: application/octet-stream`, as Nx's own client does: an API gateway that keys binary media on `Accept` base64-encodes anything else (nx#33092); `turboCache()` asks the same way.

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { nxCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [nxCache({ url: 'https://cache.example.com', token: process.env.CACHE_TOKEN })],
})
```

Every option falls back to the tool's own environment variable, and a missing token to the OS keychain ([Tokens](#tokens-and-the-os-keychain)); with no server the plugin **declines** and the run stays local.

| Option      | Environment variable                       | Meaning                                                                                                                                                     |
| ----------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`       | `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`       | base URL of the cache server; http(s) only (http to any host, as Turbo and Nx take it); a `user:pass@` in it is refused, the option's when the config loads |
| `token`     | `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | Bearer token, else the OS keychain; `''` (option or variable): an open server                                                                               |
| `timeoutMs` | —                                          | per-request deadline (default 30 s; ms above 0, up to 2³¹−1)                                                                                                |
| `retries`   | —                                          | resends, as `turboCache()`'s (default 1)                                                                                                                    |

The Nx spec has no existence probe, so `has` (the `--dry` prediction; the prefetch pass calls `get`) is a `GET` whose body is cancelled before it answers. The wire carries no producing-task duration, so a remote hit reports none.

## OIDC on GitHub Actions

`turboCache({ oidc: true })` needs no `TURBO_TOKEN` secret on GitHub Actions: before the first task, when the run's policy uses the remote, it asks GitHub for the job's OIDC token (`ACTIONS_ID_TOKEN_REQUEST_URL`, with `audience` when given), exchanges it at the token endpoint (RFC 8693) for a short-lived cache token, and revokes that (RFC 7009) when the run ends. With Vercel's hosted cache the endpoints, Vercel's OAuth client id and `team_id_or_slug` (the team id, else slug; one is required) are the defaults, as Vercel's own action sends them; `params` adds fields such as `policy_id`. Any other server names its `tokenUrl` (and `revokeUrl`, or none); `params` carries its extras. `revokeUrl: false` skips the revoke.

```yaml
permissions:
  id-token: write
```

- Order: the `token` option, `TURBO_TOKEN`, then OIDC, then `.turbo/config.json`, then the OS keychain.
- A request is tried three times on a `429`, a `5xx` or no answer, 30 s each. A failed exchange is one warning and a local-only run; a failed revoke is a warning (the token expires on its own). No message quotes a token.
- A job without `id-token: write` gets no OIDC variables: one warning, and the sources below OIDC answer. A pull request from a fork, and a Dependabot one, never gets an OIDC token.
- `nxCache()` has no OIDC: Nx's cache spec names no exchange.

## Tokens and the OS keychain

With no token from an option, a variable or a config file, both plugins read the OS keychain through core's `ctx.secret` (`Bun.secrets`: macOS Keychain, libsecret, Windows Credential Manager), service `@vzn/vx-migrate`, entry named by the endpoint and team: `https://remote.cachely.dev/v8/artifacts#cachely` (`turboCache()`, team id else slug; no `#…` without a team) or `https://cache.example.com/v1/cache` (`nxCache()`). So separate caches never share a token.

- Read once per run, only by a run that uses the remote: before its first task, when its policy reads or writes the remote. `--no-cache`, `--cache-policy=remote:`, `--dry`, `vx show` and `vx info` never touch the keychain. Off CI, remote writes are already off by default ([`cli.md` § Cache control](../vx/docs/cli.md#cache-control---cache-policy---no-cache---force)).
- Missing, on a terminal (stdin and stderr TTYs, `CI` unset): asked once, input hidden — `Token for remote.cachely.dev (cachely), saved to the OS keychain: ` — and saved. Later runs read it without asking.
- Missing anywhere else (CI, piped), or an empty answer (Ctrl-C stops the run): one warning naming the remote and the fixes (set `TURBO_TOKEN` / `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, run in a terminal, or `--cache-policy=remote:` to skip the remote), and the run goes on with the local cache.
- A keychain token the server refuses (`401` / `403`) is deleted, with the warning, so the next run asks again. A token from an option or a variable is never deleted.
- No keychain (headless Linux without libsecret) reads as empty; it never breaks a run.
- The token never reaches a task: the task environment does not pass `TURBO_TOKEN`, `VERCEL_ARTIFACTS_TOKEN` or Nx's variable.

## Remote-cache behaviour (both)

- Task keys carry no branch. `turboCache()` names the run's refs on every read (`HEAD`, `GET`, the batch `POST`) in `x-artifact-read-scopes`, own branch first (`refs/heads/feat-x, refs/heads/main`): from CI's env, else git's current branch, then the default branch. A `PUT` names none: where a write lands is the server's call, from the CI OIDC token checked against its trust policy. `scope: 'key'` hashes the ref into each key instead, for a server that ignores the header. `nxCache()` sends plain requests.
- The batch `POST` carries at most 100 hashes, Vercel's limit; more go in parallel batches. A batch refused with any status but 404, 405 or 501 (no batch query) is reported with its body, and so is a 200 answer that is no JSON object. How a server implements the header: [Branch caches a server enforces](https://vznjs.github.io/vx/blog/branch-caches-a-server-enforces/).
- A remote error degrades to a **miss** and a warning that names the request, the artifact and the server — `[vx] plugin '@vzn/vx-migrate': upload 32248a2a7c89e241 to https://cache.example.com/v8/artifacts failed: no answer within 60000 ms` — never the token. The run never fails because of the cache.
- A hit that does not restore (bad bytes, a signature that does not verify) re-runs the task, and `turboCache()` uploads its save over the stored entry, skipping the `HEAD` it asks before other uploads. Nx's records are immutable (`409`), so `nxCache()` cannot repair one.
- The same failure is said once per run: an unreachable server fails the probe, the download and the upload alike, and the run prints the first and, at its end, `[vx] plugin '@vzn/vx-migrate': 2 more requests failed the same way: Unable to connect. Is the computer able to access the url?` (core does the counting, for every cache plugin).
- A request answered `5xx` (not `501`), or one that never connected (a refused port, an unresolved host), is sent again after 2 s, `retries` times. A `429` pauses every request to that remote for its `Retry-After` (capped at 10 s a wait, 2 s without one), and the request is sent again when the pause ends, for up to 20 s from its first `429`, as Turbo's client does. A spent deadline is not resent: it has already cost its wait.
- Three outages in a row (no connection, no answer within the deadline, or a `5xx` once the resends are spent) open Turbo's outage breaker: no request is sent for 30 s, each lookup is a miss at once, then one request probes and its answer closes or reopens it. A hit is judged when its body ends, so a server that sends headers and then stalls the body counts the same way. A hung server costs three deadlines, not one per task.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process (a `403` on an upload is a read-only token — Nx's spec, or turborepo-remote-cache's `READ_ONLY` and write-less JWTs: it turns off uploads alone, and reads go on) — including the requests already in flight when the refusal lands, which degrade in silence rather than repeating it (a six-project run printed five identical lines before 2026-09-20).
- Policy (`--cache-policy=remote:r`, `VX_CACHE_POLICY`, `cache.policy`) is enforced by core, which layers each plugin's remote over the local cache — a read-only token pairs naturally with `remote:r`.
- Core's policy alone decides reads and writes: the plugins read none of Turbo's or Nx's own switches (`TURBO_CACHE`, `TURBO_REMOTE_CACHE_READ_ONLY`, `NX_SKIP_REMOTE_CACHE`, `NX_DISABLE_REMOTE_CACHE`); `turbo()` reads `TURBO_FORCE`, as `--force`. A CI that keeps untrusted pull requests off the shared cache sets `cache.policy` or `--cache-policy=local:rw,remote:r` for them.

## Testing

`bun test` runs the Turbo and Nx plugins over fixture workspaces (the Nx one against a fake `nx` whose graph export and `runExecutor` are stubs, so the vx → `nx-exec` → executor → cache round trip is real), the migrate CLI over both sources, and each remote-cache wire against a strict in-memory implementation of its spec plus a full `vx run` round trip (miss → upload → local wipe → restore from the server). A separate suite points both plugins at a HOSTILE server — 500 on every request, 401, a server that never answers, and a body that is not an artifact — and pins that each one degrades to a miss with the run still green. `tests/nx-exec-live.test.ts` runs `nx-exec` against REAL Nx when `VX_NX_MODULES` names a directory whose `node_modules` holds `nx`, `@nx/js` and `typescript` (CI installs one under `packages/vx-migrate/.nx-live` and sets `VX_REQUIRE_NX=1`, so an absent install fails there instead of skipping).
