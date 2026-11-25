# @vzn/vx-migrate

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-migrate/> · source: <https://github.com/vznjs/vx>

This package moves a repo to [`@vzn/vx`](https://vznjs.github.io/vx/). It has zero dependencies.

It reads Turborepo, Nx, Vite Task or plain `package.json` scripts. It holds four tools:

- **`turbo()`**: a temporary start for a Turbo repo. It fills vx's tasks from `turbo.json` and each package's scripts until you write native config.
- **`nx()`**: the same temporary start for an Nx repo, filled from Nx's resolved project graph.
- **`bunx @vzn/vx-migrate`**: writes one `vx.config.ts` per workspace package, plus the workspace file every run needs.
- **`turboCache()`** and **`nxCache()`**: keep the remote cache you have.

<details><summary>Details</summary>

- `turbo()` makes each package-manager member a project, through the `discover` stage. Core alone finds only directories holding a `vx.config`.
- `turbo()` fills vx's `project` stage until the migrator writes native config.
- Under `nx()`, executor targets (`@nx/js:tsc`, `@nx/vite:build`, your own) run as themselves through **`nx-exec`**, one executor per process.
- `nx()` and `nx-exec` use the repo's own `nx`, versions 22 to 24 (an optional peer dependency).
- `bunx @vzn/vx-migrate` reads your `turbo.json`, an exported Nx project graph, or vite-plus's `run.tasks` (Vite Task, `vp run`).
- With none of those, it reads each package's `package.json` scripts.
- It runs without a workspace file, so it is your first command, not your second.
- `vx init` runs it in a repo with a `turbo.json`, `turbo.jsonc`, `nx.json`, an exported Nx graph or Lerna on Nx.
- `turboCache()` speaks Turbo's `/v8/artifacts` API, so any such server works, Vercel's hosted cache included.
- `nxCache()` speaks Nx's self-hosted `/v1/cache` spec.

</details>

```sh
bun add -d @vzn/vx @vzn/vx-migrate
```

In a Turbo or Nx repo, `bunx @vzn/vx init --keep` runs this package.

It writes the `.vx/workspace.ts` that declares `turbo()` or `nx()`, installs what it imports and writes the lock.

Where the repo shows a remote cache, it declares `turboCache()` or `nxCache()` too. Written by hand, the file reads:

```ts
// .vx/workspace.ts — a Turbo repo mid-migration, with its remote cache
import { defineWorkspace } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'
import { turbo, turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turboCache(), turbo(), bun()] })
```

`turbo()` reads no package edges: the lockfile plugin (`bun()`, `pnpm()`, `npm()` or `yarn()` from `@vzn/vx-lockfile`) gives `^build` its order. Without it, `vx lock` refuses a `^` edge.

The package exports `turbo`, `nx`, `turboCache`, `nxCache` and their options types.

The options types are `TurboPluginOptions`, `NxPluginOptions`, `TurboCacheOptions` and `NxCacheOptions`. The mappers and cache clients are internal.

## `turbo()` — a Turbo repo, mid-migration

`turbo()` runs each package's scripts the way `turbo run` would, until `bunx @vzn/vx-migrate` writes native config.

```jsonc
// turbo.json
{ "tasks": { "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] } } }
```

With this file, `vx run build --all` runs every package's `build` script after its dependencies' builds, and caches `dist/**`.

`vx lock` maps it. What it maps:

- `dependsOn` edges: `^build`, same-package deps and `pkg#task`.
- `inputs` as every task's key, and `outputs` as `cache: true`.
- `env` / `passThroughEnv`, `cache: false` and `persistent`.
- Per-package `turbo.json` overlays.

<details><summary>Details</summary>

- Turbo's global fields (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`, Turbo 1's `globalDotEnv`) are inlined into every task.
- A `*` env name (`NEXT_PUBLIC_*`) is kept as written. Core matches it against each run's environment, as Turbo does.
- `*` is Turbo's only wildcard: `\*`, a leading `\!`, `?` and `[` are literal.
- A literal vx cannot key (unkey's `NEXT_PUBLIC_\*`) is left out and reported once.
- A `turbo.jsonc` (Turbo 2.5+) is read wherever a `turbo.json` would be, at the root and in a package.
- A directory holding both is refused, as Turbo refuses it. A workspace root with neither is refused, naming the fix.
- An absolute path in `inputs`, `outputs`, `globalDependencies` or `global.inputs` is refused, naming the file, as Turbo refuses it.
- Turbo 2's framework inference applies too. A package on `next` has `NEXT_PUBLIC_*` and `NEXT_DEPLOYMENT_ID` hashed and passed.
- Turbo's whole framework table applies (`expo`, `nuxt`, `remix`, `@sveltejs/kit` and the rest).
- Each package takes the first framework it matches, as Turbo does.
- The prefix lands in that package's `inputs.env` as a pattern.
- vx has no exclusion: a `!` entry or `TURBO_CI_VENDOR_ENV_KEY` cannot take names back from it, so those stay keyed.
- Turbo's builtin env applies as Turbo's source has it. `VERCEL_ANALYTICS_ID` and `VERCEL_TARGET_ENV` are keyed in every task.
- A `globalEnv` `!` entry such as `!VERCEL*` takes them back.
- Next's skew rule keys `VERCEL_DEPLOYMENT_ID` always, where Turbo keys it under `VERCEL_SKEW_PROTECTION_ENABLED=1`. The lock does not depend on the machine.
- Turbo's builtin pass-through list (`TZ`, `HOME`, `CI`, `VERCEL_*`, `GITHUB_*` and the rest) reaches every task unkeyed, patterns as written.
- A written config carries none of Turbo's own env and none of the global fields. It holds only what each task declares.
- So the first run after migrating runs each task once more.

</details>

| Option | Meaning                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| `root` | Directory holding `turbo.json`, relative to the workspace root or absolute. Defaults to the workspace root. |

### Locking

`vx lock` makes the mapping, and nothing else does.

```sh
vx lock          # map turbo.json and the scripts into .vx/projects.lock
vx lock --check  # name each package the mapping now says otherwise for
```

- `vx lock` maps `turbo.json` and the scripts, and records each package's final tasks in `.vx/projects.lock`.
- A package with no `vx.config` is included.
- A run reads that record and maps nothing. It reads no `turbo.json`, manifest, git or environment for the mapping.
- So an edit to `turbo.json` or a script runs only after the next `vx lock`.
- Until then a run on this machine refuses: `turbo.json changed since the last \`vx lock\` — run \`vx lock\``, as for an edited `vx.config`.
- An edit that maps the same (a version bump) runs.
- A package `turbo.json` added since counts as an edit too.
- A package added since has no tasks until `vx lock`.
- Adding or dropping `turbo()`, or editing its options, is refused the same way, naming `.vx/workspace.ts`.

### What it does not do

- A task the package's own `vx.config` already declares is left alone: the plugin fills, it never overwrites.
- Migrate a package by writing its config. The rest of the repo keeps running from `turbo.json`.
- The mapping's gaps are the migration's gaps. `vx lock` (and `vx lock --check`) reports them as warnings, never a run.
- They are warnings instead of `TODO(vx-migrate)` comments. `bunx @vzn/vx-migrate --dry` lists the same set once.
- The cost is `vx lock`'s: on a 1,000-package workspace with no `vx.config` files, the mapping takes about 42 ms.
- A run pays none of it; it reads the lock.
- Under `vx watch`, as on any run, a `package.json` script or `turbo.json` edit is refused until `vx lock`.

<details><summary>Details</summary>

- The gaps include `$TURBO_ROOT$` tasks and unknown turbo keys.
- They include an env name vx cannot key that the run's environment sets (`FOO_?`, which Turbo reads literally).
- A persistent task's readiness note (`readyWhen`) is reported only when something depends on it. With no dependent there is nothing to gate.
- Each gap is one line for every task that carries it, not one per task.
- A per-package `{ "extends": false }` with nothing else is Turbo's opt-out, and maps to no task.
- With other keys beside it, the task runs on those keys alone.
- A glob that climbs out of the package (`../../packages/app-store/*.generated.ts`) is re-anchored on the workspace root as a `workspaceFiles` glob.
- A glob's `.` and `..` segments are cleaned first, as Turbo cleans them. `./src/**` is `src/**`.
- Likewise `./../shared/**` and `src/../../shared/**` are `../shared/**`.
- A negated output under a literal-rooted one (`dist/**` minus `!dist/**/*.map`) takes its paths back (see `outputs` below).
- One against a wildcard-rooted output (`*/**` minus `!src/**`) keeps what it names (see `outputs` below).
- `vx lock` keeps the mapping in `<cache dir>/vx-migrate-turbo-mapping.json`. No run reads or writes it.
- It is keyed on every `turbo.json` / `turbo.jsonc`, every package manifest, the files git ignores and the mapper's own code.
- So a second `vx lock` (or `--check`) with none changed reads it instead of mapping.
- On astro (562 packages) that is ~40 ms of mapping against ~12 ms of key reads.

</details>

### The mapper (`mapTurboWorkspace`)

The plugin and the CLI read a repo the same way.

- The mapper the plugin runs at `vx lock` is the one `bunx @vzn/vx-migrate` writes each `vx.config.ts` from.
- The CLI runs it with `ownOnly`: no task carries Turbo's global fields or its implicit hash inputs.
- The plugin inlines those into every task. A global input another task writes to is taken back (`!packages/plugin/dist/**`).
- `splice` is what a global becomes in the plugin's arrays. `uses` names which globals a task drew on.

Rules:

**Which tasks exist.** A task exists for a package only when the package declares the script. That is Turbo's own rule.

- An absent script is silent.
- A script key whose value cannot be a command (a number, `null`, an empty string, an array) gives a `task: null` entry.
- Its todo says why, rather than writing a config that fails to load.

**Definition order.** The root definition comes first, then each config the package's own `turbo.json` extends, then its own.

- The root `pkg#name` is used if there is one, else the root `name`. The first replaces the second whole, as Turbo looks it up.
- Extended package configs (`"extends": ["//", "shared"]`) come nearest last. Each wins field by field.
- Turbo 2.11 reads such an `extends`, and 2.5 refuses it. A missing parent or a cycle is refused, as Turbo refuses it.
- An overlay array holding `$TURBO_EXTENDS$` (Turbo 2.5+) is the inherited list plus the overlay's other entries.
- Example: `inputs: ["$TURBO_EXTENDS$", "config.json"]`.

**The command is the script body**, with its `pre<name>` / `post<name>` hooks joined in, in that order, through core's `foldScriptHooks`.

- Each part runs in its own subshell, and the chain stops at the first that fails.
- Forwarded `--` args reach the body alone.
- A part reading `$npm_lifecycle_event` gets its own name (`prebuild`, `build`, `postbuild`), as npm gives each.
- npm and pnpm run the hooks around `<name>` without being asked. For example, novu's `prebuild` copies the CSS its `build` inlines.
- This costs one process less per task than `pnpm run <name>`.

<details><summary>Details</summary>

- A body may call yarn's `run` builtin (`run -T rollup -c`, `run clean && run build`). In sh that is `run: command not found`.
- So such a body runs as `yarn run <name>`, as Turbo and Nx run it. Yarn 2 and later run scripts in their own shell.
- Yarn 2 and later run no hooks, so none are joined there.
- Nor are hooks joined where the package's manager runs none. That is Yarn 2+, npm under `ignore-scripts=true`, and pnpm under `enable-pre-post-scripts=false` or `enablePrePostScripts: false`.
- Turbo and Nx run `<pm> run <name>` there, so the hook never ran. The scripts mapper of `bunx @vzn/vx-migrate` follows the same rule.
- An `.npmrc` or `pnpm-workspace.yaml` change maps afresh.
- A Yarn Plug'n'Play workspace (`.yarnrc.yml` with no `nodeLinker`, or `pnp`) has no `node_modules`.
- There a dependency resolves only through `.pnp.cjs`, and a bin only through yarn's shims.
- So there every script runs as `yarn run <name>`, and a `nodeLinker` change maps afresh.
- The same rules apply to `nx:run-script` below.

</details>

**Turbo 2.11's task `command`** (`futureFlags.experimentalTaskCommand`) wins over the script, as Turbo holds it.

- An argv is the command: each word quoted, run from the package dir, with no `pre`/`post` hooks.
- It gives the package the task even with no script (turborepo's `@turbo/types#build`, `docs#schema`).
- `null` or `[]` is Turbo's no-op node: no task, even where the script exists. Its edges are passed through.
- A per-toolchain map applies its `javascript` entry (or `typescript`, Turbo's alias). Without one, the script runs.
- A shape Turbo would refuse keeps the script, with a todo.

**`dependsOn`** becomes vx edges.

- `^x` passes through when some package runs `x` or turbo.json defines it. Otherwise it is dropped.
- Core refuses a `^x` no project declares, as a typo.
- A `^x` or `x` that turbo.json does not define at all (a typo, `^biuld`) is dropped with a todo naming it, as Turbo refuses it.
- `pkg#task` is kept only when `pkg` emits `task`. Otherwise the edge is dropped with a todo.
- That todo names turbo.json when it defines no `task`, which Turbo refuses.
- A name Turbo does not define has no edge. `$TURBO_ROOT$` deps are a todo.

<details><summary>Details</summary>

- A same-package task Turbo defines, but the package has no script for, is Turbo's no-op node. Its own edges pass through in its place.
- Example: `test → codegen → ^build` with no `codegen` script is `test → ^build`.
- Another package's `^x` or `pkg#x` reaches such a node through a group task when its edges name a task of its own package or another.
- Example: with-tailwind's `ui` has no `build` script. Its `build` builds `build:styles` and `build:components`, and `web#build` waits on them.
- So does a node whose `^` edge names another task (rallly's script-less `build` holds `^db:generate`).
- A node whose only edge is `^` to its own name needs no group, since core's `^x` walks past a package without `x`.
- A no-op node nothing else reaches is a group too, in a package nothing but the root depends on. No dependant's `^` edge runs its edges there.
- Example: vercel/ai's `turbo run type-check` builds each example through its script-less `type-check: [build]`.
- Example: kitchen-sink's `turbo run test` builds `@repo/ui` for `admin`, which has no `test` script.
- Elsewhere it is no group when its dependants' run reaches each edge.
- That is an edge to a task of its own package some `^` edge names (`test: [build]` beside `^build`), or a `^` edge in a package that depends on none.
- Otherwise it is a group, since Turbo runs a no-op node's edges in every package.
- Example: `turbo run deploy` over `deploy: [build, test, lint]` ran each package's `test` and `lint` where one package has `deploy`.
- That was checked on turbo 2.11.10.
- A task turbo.json defines and no package has a script for is a group task in each package that defines it, its edges kept.
- Examples: documenso's `lint`, shadcn-ui's `check`.
- There a `pkg#task` edge is kept only in `pkg`, and a `//#task` edge in a group of the same name on the root project.
- So `vx run lint` runs Turbo's no-op nodes and exits 0, as `turbo run lint` does.
- Root `//#task`s run in the workspace root, as under Turbo.
- When turbo.json declares one, `turbo()` names the root a project through core's `discover` stage. No `vx.config` is needed.
- It names every package the package manager lists the same way.
- `//#x` in `dependsOn` is an edge to the root, named by the root `package.json` `name`.
- A root task's globs are the workspace's (`workspaceFiles`), since Turbo hashes a root task over the whole repo.
- With no root project (a root `package.json` with no `name`, or one a package holds), the globs are a note and such an edge a todo.
- Turbo runs no plain task in the root package of a monorepo, and neither does `turbo()`.
- In a single-package repo (no workspaces, Turbo's `non-monorepo` example), turbo.json's plain tasks run on the root package, as under Turbo.

</details>

**Transit nodes.** Turbo's with-vitest example documents this pattern: `transit: { dependsOn: ["^transit"] }` with no script anywhere, and `test: { dependsOn: ["transit"] }`.

- A transit node is a key-only task in each package that defines it. It is a no-op task (no command, nothing spawns) keyed on its inputs.
- It keeps its `^transit` edge. So a dependant's `test` re-keys on its dependencies' sources, as Turbo re-hashes it.
- A `^` task that some package has a script for, or that nothing depends on, is no transit node.

<details><summary>Details</summary>

- A package without the script of a `^` task others run gets the same key-only task, as Turbo hashes a no-op node there.
- An edit to it re-keys its dependants, also when the task is `cache: false`. The node stores nothing; Turbo hashes it cached or not.
- A `build` whose only edge is `^build` is not written: core gives every project with no `build` that node.
- `turbo()`, which writes nothing, keeps it. Core's node is skipped by a bare name.
- Without it, `vx run build` scoped to such a package (its directory, `--filter`) is refused where Turbo builds its dependencies.
- A dependency without the script, whose own edges lack `^x`, gets the task too. So a `^x` stops there, as Turbo's does.
- Example: opencode's `build: { dependsOn: [] }`. Without the task, core walked past to the builds below, which Turbo's `^build` never reaches.

</details>

**`with`** names tasks Turbo runs alongside, such as `web#dev` with `api#dev`.

- Each sidecar that is persistent becomes an edge. vx starts the task once the sidecar has spawned.
- vx runs the sidecar only when the task runs.
- A sidecar that ends would be waited for, so it is a todo instead.
- A pair that names each other keeps one edge; two would be a cycle.
- A task with no script whose `with` names persistent sidecars is a group task that depends on them.
- Example: in Turbo's with-tailwind, `ui` has no `dev` script. Its `dev` starts `dev:styles` and `dev:components`.

**`inputs`.** Absent or `[]`, a task's inputs are `**/*`, Turbo's default.

- `$TURBO_DEFAULT$` is `**/*`.
- Exclusions alone narrow nothing, as in Turbo, which keys only `package.json` then.
- An explicit list also keys the package's own `package.json`, as Turbo does whatever the negations.
- So a negation that matches `package.json` (`!**/*.json`, `!**`) is dropped. That keys more, never a stale hit.
- `$TURBO_ROOT$/<path>` is `inputs.workspaceFiles`, negation kept. Any other `$TURBO_ROOT$` use is a todo.

<details><summary>Details</summary>

- A structured entry (Turbo 2.11) is its `globs`, plus `**/*` with `withDefaults`, for `startup` and `jit` alike.
- Turbo hashes the startup and jit lists apart.
- So a `!` in one that may reach the other's globs (`"!src/generated/**"` beside a jit `src/generated/**`) is dropped. That keys more, never a stale hit.
- `dependencyOutputs` adds nothing where the producer is cached: vx hashes each dependency's key into it.
- From a `cache: false` producer, the named files, or its outputs, are an `inputs.workspaceRuntime` probe.
- Example producer: vercel/vercel's `//#generate:cache-keys`, which records the host.
- There `inputs.tasks` leaves the producer out (also one a `^` edge reaches), so core answers the probe after it ran.
- `globalDependencies` and Turbo 1's `globalDotEnv` land in `workspaceFiles` too.
- Turbo hashes `globalDependencies` apart from a task's own inputs, so neither's `!` reaches the other's files.
- vx subtracts each `!` from the whole list. So a `!` that may reach the other side's files is dropped, which keys more, never a stale hit.
- Turbo 2.11's `global.inputs` joins each task's inputs, where its `!` entries apply.
- A task's Turbo 1 `dotEnv` lands in its `files`.
- Turbo 1's `$NAME` entries, in `globalDependencies` or a task's `dependsOn`, are env vars. They join `inputs.env`.
- Turbo hashes a package nested in the task's package with its parent (cal.com's apps inside `@calcom/app-store`).
- Core's globs stop at a project. So each glob that reaches a nested package is also listed in `inputs.workspaceFiles`.
- Turbo's glob grammar is translated as Nx's is: `*.[jt]s` is `*.{[jt],j,t}s`.
- An input with no safe form widens to `**/*` with a todo.
- A wildcard `X/**` input, `!` or not, also lists `X`, as outputs do.
- Turbo's `**` matches zero segments, so `*/**` keys on the package-root files too.
- A `.env`-shaped input is gitignored as a rule, so git never reports it as a file. It is keyed by a probe instead.
- Such inputs: `.env*`, `.env.local`, a task's Turbo 1 `dotEnv`, create-turbo's `globalDependencies: ["**/.env.*local"]`.
- For a package, the probe hashes the `.env` files it can name (`inputs.runtime`).
- For a root entry, it hashes the files its root-relative globs name, hidden ones too, as Turbo's `*` matches them (`workspaceRuntime`).
- There `**/<name>` is a `find -name` that skips `node_modules`, and another `**` walks the workspace.
- A package whose `.env` globs all sit at its root gets a one-shell probe of that directory. One below the root walks the package.

</details>

**`outputs`.** Outputs are what a task caches. vx cleans them before every run and every restore.

- `""`, `"."`, `"./"`, `**` and `**/*` are the whole package in Turbo, which caches every file in it.
- Example: graphql-hive's `check:build` writes `[""]` (checked on turbo 2.11.10).
- Core refuses `.`, and `**` beside the default `**/*` inputs. So each maps to `*/**`, with the `*` its zero segments add.
- Those are the same files, cleaned only where git tracks none (see the wildcard rule below).
- As an input, `""`, `"."` and `"./"` are every package file, `**/*`.
- `$TURBO_ROOT$/<path>` is `outputs.workspaceFiles`.
- Turbo caches whichever outputs a run wrote; vx fails a task that writes none.
- A `coverage` output is written only with coverage on, so the migration names it as a todo unless the command turns coverage on (`--coverage`).

<details><summary>Details</summary>

- An output whose literal head lies in a nested package is a `workspaceFiles` output too, named from the workspace root.
- Example: trpc's `examples-minimal-react#build` outputs `client/dist/**`, its nested `client` package's.
- That is because a project's globs never reach another project.
- A negated output rides beside its positives. It takes its paths back from the clean, the save and the restore.
- Example: Next's `.next/**` minus `!.next/cache/**` keeps the cache.
- One with no positive beside it takes back nothing, and is dropped.
- A path a negated output takes back is also left out of the task's own inputs when git tracks no file under it.
- The task still writes it. Where it is not gitignored (`!dist/skip/**`), it changed after the key was taken, so no run was saved.
- One over a committed file is source and stays an input, as Turbo keys it. Examples: medusa's `!src/**`, `lib/**` minus `!lib/vendor/**`.
- Without git, every one stays.
- Another task of the package may take the positive output back in its inputs, and so hide that file.
- That task drops the take-back if it is key-only. Otherwise it runs uncached with a todo.
- Core refuses an input that reaches another task's output.
- Past its first segment, an output takes Turbo's grammar (`dist/**/*.[cm]js`). The first segment stays a literal (a route directory).
- A wildcard `X/**` also lists `X`, since Turbo's `**` matches zero segments.
- So medusa's `*/**` caches the package-root `tsconfig.tsbuildinfo` too. Its `package.json` is taken back (below).
- A literal `dist/**` needs no `dist`.
- An output whose first segment is a wildcard (`**/*.d.ts`, medusa's `*/**`) stays cached, as in `nx()`.
- Turbo never cleans an output. vx cleans it before every run and every restore, and such a glob can reach the sources.
- Core never cleans a committed file. Every untracked file the glob reaches is deleted, and `vx lock`'s warnings say so.
- The warning reads `output "*/**": … every untracked file this glob reaches is deleted`.
- Negations beside it (`!src/**`) keep what they name.
- Without git the files cannot be told apart, and the task runs uncached with a todo.
- A glob that reaches no tracked kind gets no warning. One kind is a single segment with a literal extension the package tracks no file of (`*.xml`).
- Another is `**/<dir>/**` when the package tracks nothing under a directory of that name (vercel/ai's `**/dist/**`).
- Another is a first segment no tracked top-level entry matches (tldraw's `dist-*/**`).
- An output may cover the package's own `package.json` (trpc's client build lists it: the build rewrites `exports`).
- Then `!package.json` takes the manifest back and the task keeps its cache, in `turbo()` as in `nx()`. Otherwise vx would delete it before every run.
- The build rewrites a file it may list as an input (`@vzn/vx-lockfile` lists `package.json`).
- So the Turbo mapping also sets `inputs.stability: { strategy: 'mutable' }`, and an identical rewrite counts as unchanged.
- The same holds for an output that covers the package's vx.config.
- `turbo()` and `nx()` check the config the package has, and `vx-migrate` the one it writes. So sanity's `*.js` shims stay cached beside none.
- A command that runs `tshy` gets the same stability with no output naming the manifest.
- tshy rewrites `exports` on every build. Without this, trigger.dev's tshy builds were never saved.
- A committed file under an output needs nothing (typescript-eslint's `data/sponsors.json` in a cached `data`).
- Core never cleans a file git tracks, so it survives and the task keeps its cache.
- A task whose command runs `tsc` that writes a `.tsbuildinfo` outside its outputs also outputs that file.
- That is tsc with `-b`, `composite` or `incremental`, read through the tsconfig's `extends` and, for `-b`, its `references`.
- A solution tsconfig (`files: []`, references only) writes none: Vite's react-ts starter has one.
- Why: tsc re-emits only what its buildinfo calls changed.
- With `rootDir: "src"` and `outDir: "dist"`, its `tsconfig.tsbuildinfo` beside the tsconfig survived the clean before a miss.
- That miss cached a `dist/` holding only the edited file. Nx infers the file as an output; Turbo never cleans `dist/`.
- `vue-tsc`, `tsgo`, `tspc` and `ttsc` count as `tsc`.
- An extended config package (`@repo/tsconfig`, linked by the workspace) is read at its real path, as tsc reads it.
- So a `tsBuildInfoFile` it sets is that package's file, not an output of each package that extends it.
- A command that runs tsc unseen cannot be followed (remotion's `node ../.monorepo/tsrs.cjs -d`, a script that loads tsc).
- There the task may get a todo naming the file to add. The mapping does not guess what a script runs.
- That happens where the package's `tsconfig.json` is incremental, emits into an output, and keeps its buildinfo outside the outputs.

</details>

**Gitignored inputs.** A gitignored file an input names by path is keyed, as Turbo hashes it. The path stays as written and core reads it from disk.

- An ignored file under a glob is not an input. Turbo walks an explicit glob on disk, ignored files and all; vx's globs skip them, as core's do.
- The lock is committed and an ignored file is on one machine only, so the lock never depends on one.
- To key one, name it in the input (`src/env.local`) or commit it.

**A glued `**`.** A `**` glued to text in an input, output or `globalDependencies` glob is read as Turbo reads it.

- `src/**.ts` is `src/**/*.ts`, and `gen**` is `gen*/**`.
- Core refuses the glued spelling.

**A bracketed path.** An input or `globalDependencies` segment such as `[locale]` that names an existing path is read literally, as Turbo reads it.

- `app/[locale]/**` is `app/\[locale\]/**`. A class naming no path (`*.[jt]s`) stays a class.
- Core refuses the class spelling of an existing path.

**`env` / `passThroughEnv`.** `env` goes to `inputs.env` (seen and keyed), `passThroughEnv` to `exec.env.passThrough` (seen only), each with its global list.

- A wildcard (`API_*`) is kept as written. Each run matches it against its own environment, as Turbo does.
- A name both a global list and the task's own list carry is listed once.

<details><summary>Details</summary>

- `*` is the only wildcard, as in Turbo: `\*`, a leading `\!`, `?` and `[` are literal.
- So unkey's `NEXT_PUBLIC_\*` names one variable, which vx cannot key.
- It is dropped and reported once for the workspace, with the count of tasks naming it.
- A `!` entry (openstatus' `!NEXT_PUBLIC_VERCEL_URL`) removes that literal from its list.
- vx has no exclusion, so a `!` entry a kept pattern still matches is a todo: narrow the pattern to leave the name out.
- A name that is no shell variable name (`p-q`) is keyed, but `sh` drops it before the task runs.

</details>

**Framework inference.** Turbo hashes and passes Next's `NEXT_PUBLIC_*`, Vite's `VITE_*` and others for a package that depends on the framework.

- The prefix (`NEXT_PUBLIC_*`) is written as a pattern, which each run matches, as an env wildcard above.

**Two tasks of one package on one output path.** vx cleans a task's outputs before it runs and before a restore.

So the loader refuses two cached tasks whose outputs provably overlap. Example: strapi's `build`, `build:code` and `build:types`, all on `dist/**`.

- The mapping resolves it before the file is written.
- `build` keeps its cache. Else the task with a `^` edge keeps it, else the first declared.
- The rest run uncached, with a todo naming the keeper and the fix: their own output path.
- The same rule applies to Nx targets.

<details><summary>Details</summary>

- Under vx's default `rules.exclusiveOutputs`, an edge between the two changes nothing.
- Example: twenty's `build:individual` writes into `build`'s `dist`.
- Example: typescript-eslint's `typecheck` has `^typecheck` and writes declarations into `build`'s `dist`. Keeping it left `build` uncached.
- A shared tsc incremental file stays with the keeper alone.
- Example: create-t3-turbo's `build` and `typecheck` are both on `.cache/tsbuildinfo.json`.
- The other task keeps its cache when it emits nothing else (a typecheck).
- One that emits more runs uncached, as `tsc --incremental` skips files the keeper's tsbuildinfo calls built.
- When either side is a directory at any depth, the two meet only where one tree nests in the other.
- Example: solid's build `**/dist` and its types `**/types`.
- There the keeper takes the sibling's glob back (`!coverage/**`, `!**/types`), and both keep their cache, as under Turbo.
- The cached task may depend on the one it outruns. Then its todo says its clean deletes what that task wrote.
- Example: mastra's `build` (api-extractor over `dist`) runs after `build:lib` (tsdown into `dist`).
- vx is right to clean, and the source config is yours to fix.

</details>

**A task whose inputs read another task's outputs.** Example: a `test` keyed on `**/*` beside a `build` writing `dist/**`.

`vx lock` refuses such a task, since its key cannot be known before the producer ran.

- Each overlapping output is taken back from the reader's inputs with `!` (`['**/*', '!dist/**']`).
- This holds in package and workspace inputs alike.
- A workspace output another package writes into this one is taken back from its package inputs too.
- Turbo and Nx hash what git tracks, and a build's outputs are not tracked. So the key reads what the adopted tool read.
- The same applies to Nx targets.

<details><summary>Details</summary>

- A literal input another task writes cannot be taken back: that task runs uncached with a todo.
- Under `turbo()`, so does a glob that names another task's output when no `dependsOn` path reaches that task.
- Example: `build` reads `gen/**` beside a `gen` writing `gen/**`.
- Why: Turbo walks an explicit glob on disk, so it re-runs `build` after `gen` rewrites it. Taken back, `build` replayed the old output.
- A glob led by `**` (`**/*.ts`) keeps the `!`, as the default does.
- A committed file under such an output is still a source. A reader the `!` would hide it from runs uncached with a todo.
- A no-op task (an `inputs:<name>` twin, a transit node) runs nothing, so core lets it read what a task writes.
- Such a group gets no `!` for a literal, the `!` that would hide a committed file goes, and it keeps its key.
- Example: typescript-eslint's ast-spec commits the `*.shot` snapshots its `test` outputs. Its twin was written as `{}`, which core refuses.
- An output that names one committed file stays an output, so a task that rewrites it caches.
- Examples: eslint's `eslint-suppressions.json` in a `lint` task's outputs, a codegen's `gen.ts`.
- A reader in its own package that runs after that task (a `dependsOn` chain within the package) drops the `!` it got for that file.
- The file stays in that key, as Turbo and Nx hash it, and the reader stays cached.
- Any other reader keeps the `!` and runs uncached with a todo.
- Core refuses a key that reads an output of a task it does not depend on.
- Example: tamagui's `clean` beside `build`'s committed `tamagui.generated.css` made `vx lock` refuse the whole workspace.
- A `^` edge is not followed, since the mapping does not know which packages it reaches.

</details>

**Two packages' tasks on one workspace output.** Core refuses two cached tasks on one path with no edge between them.

- Example: cal.com's shared `post-install` writes `../../node_modules/@prisma/client/**` from every package with the script.
- So `turbo()` (and `nx()`) keeps the first, in package and task order, cached.
- The rest run uncached, each with a todo naming the keeper.
- A package's own outputs count at their workspace path.
- Example: typescript-eslint's root project caches `dist`, and each package's typecheck `dist/packages/<name>`: one path twice.
- Edges across packages are not read, so an ordered pair loses its cache too.

**Other task fields.**

- `cache: false` or `persistent: true` gives no `cache: true`. The task is still keyed on its `inputs` and `env`, as Turbo hashes it.
- A persistent task gets `exec.persistent: {}`. When some task depends on it, the consumer gets the `persistentTodo`.
- A task's `description` (Turbo 2.11.5's schema) is the vx task's `description`.
- `outputLogs: "new-only"` maps to nothing. Frames for the tasks that ran, and a one-liner per cache hit, is vx's default flow already.
- The other `outputLogs` values are per-run in vx, so they are a todo naming the flag (`vx run … --output-logs hash-only`).
- `interruptible` maps to nothing. `vx watch` keeps a persistent task up across cycles. `bunx @vzn/vx-migrate` names each `interruptible: true` task in a note.
- It restarts it only when its config changes or it dies.
- A package's own turbo.json `tags` (Turbo 2.11.6) are its vx project `tags`.
- So `vx run build --filter tag:ci` selects what `turbo run build --filter=tag:ci` does through package tags.
- The root's tags label the root project, and none are inherited, as in Turbo.
- A task's `tags` map to nothing. vx tags belong to a project, so a `tag:` filter never reaches a task by its own tags.
- A task's `experimentalCI` maps to nothing: Turbo reads it for external CI tooling and acts on nothing.
- `envMode: "loose"` is a note: Turbo hands every task the whole environment, and vx hands only the declared names.
- That covers `envMode` at top level or in `global`, and `TURBO_ENV_MODE=loose`, which wins.
- An unknown Turbo key is a todo naming it. `extends` is accepted and ignored: the overlay order above is what it means.

**Workspace settings.** The workspace keys vx has a home for, top level or in `global`, fill what `.vx/workspace.ts` leaves unset.

- `concurrency` (`"10"`, or `"50%"` of the cores) is `run.concurrency`.
- `TURBO_CONCURRENCY` wins over turbo.json, as under Turbo. A set one decides, its `0` included.
- `boundaries.tags` is `run.rules.dependencies`. A tag's `dependencies.allow` / `deny` is its rule.
- A `dependents.deny` is each named tag's deny of that tag.
- `dependents.allow` (who may depend on the tag) has no vx form and is a note.
- A migration writes the same fields into the `.vx/workspace.ts` it writes, or names each beside one already there.

<details><summary>Details</summary>

- `cacheDir`, `cacheMaxAge` / `cacheMaxSize` and `experimentalObservability` are notes.
- They name `cache.dir`, `vx cache clean` and `@vzn/vx-otel`.
- vx's store is shared by every checkout; `cache.dir` pins one.
- `cacheMaxSize` / `cacheMaxAge` map to nothing: no vx run evicts. `vx cache clean --max-size / --older-than` does.

</details>

**Environment switches.** A few of Turbo's environment variables change what a run does.

- `TURBO_FORCE=true` (or `1`), like `turbo run --force`, turns every cache read off through the workspace's `cache.policy`.
- Each task then runs and refreshes the local cache.
- The remote is written only where `.vx/workspace.ts`'s own `cache.policy` names it. So a laptop's forced run never writes the cache CI reads.
- `vx run --force` is the flag. A `--cache-policy` or `VX_CACHE_POLICY` replaces the workspace's policy, this included.
- `TURBO_SCM_BASE`, the base `turbo run --affected` compares with, is the run's base commit (`setBranch({ base })`).
- So a bare `vx run build --affected` compares with the same ref.
- With it unset on GitHub Actions (`GITHUB_ACTIONS`), Turbo's own base applies.
- That base is a pull request's `GITHUB_BASE_REF`, else the push event's `before` from `GITHUB_EVENT_PATH`.
- `TURBO_SCM_HEAD` is the commit Turbo compares up to. vx's is its checkout: `--affected` compares the base with HEAD and its working tree.
- So a head at HEAD's commit (`$GITHUB_SHA` on a checkout of it) is honoured as is. Any other one is a warning to check that commit out.
- Turbo hashes each package's `microfrontends.json` (or `.jsonc`) into every task. So does `turbo()`.
- With `VC_MICROFRONTENDS_CONFIG_FILE_NAME` set, both hash the one file it names instead.
- `TURBO_ROOT_TURBO_JSON` is Turbo's root config path, against the cwd. `turbo()` reads only the workspace root's `turbo.json` or `turbo.jsonc`.
- So the variable is refused when it names another file.

<details><summary>Details</summary>

Turbo's run switches the plugins do not read, on purpose:

- `TURBO_CACHE`, `TURBO_REMOTE_CACHE_READ_ONLY` and `TURBO_REMOTE_ONLY`: core's `cache.policy` decides.
- `TURBO_CACHE_DIR`, `TURBO_CACHE_MAX_AGE` and `TURBO_CACHE_MAX_SIZE`: `cache.dir` decides, and no run evicts.
- `TURBO_LOG_ORDER`, `TURBO_UI`, `TURBO_EXPERIMENTAL_UI`, `TURBO_TUI_SCROLLBACK_LENGTH` and `TURBO_LOG_VERBOSITY`: vx frames each task's output its own way.
- `TURBO_RUN_SUMMARY` and `TURBO_LOG_FILE`: use `vx last` and telemetry plugins.
- `TURBO_EXPERIMENTAL_OTEL_*`: use `@vzn/vx-otel`.
- `TURBO_DAEMON`: vx has no daemon.
- `TURBO_DANGEROUSLY_DISABLE_PACKAGE_MANAGER_CHECK`: vx has no such check.
- `TURBO_ALLOW_NO_TURBO_JSON`: `turbo()` maps a turbo.json and refuses a root with none.
- `TURBO_PLATFORM_ENV` and `TURBO_PLATFORM_ENV_DISABLED`: Turbo warns of CI variables strict mode drops.
- A vx task never sees an undeclared variable, and no run warns.
- `TURBO_LOGIN`, `TURBO_SSO_LOGIN_CALLBACK_PORT` and `TURBO_CONFIG_DIR_PATH`: vx has no login verb and no user config file.
- The token comes as [Tokens](#tokens-and-the-os-keychain) says.
- `TURBO_NO_UPDATE_NOTIFIER`, `TURBO_PRINT_VERSION_DISABLED`, `TURBO_GLOBAL_WARNING_DISABLED` and `TURBO_DOWNLOAD_LOCAL_ENABLED`: the `turbo` binary's own.
- vx runs no `turbo` binary.

</details>

**Turbo 2.11's `global` block** (`futureFlags.globalConfiguration`) is read as the `globalDependencies`, `globalEnv` and `globalPassThroughEnv` it replaces.

- One difference: a task's `!` input takes a `global.inputs` file back, as Turbo prepends them to each task's inputs.

**The root `engines`.** Turbo hashes the root `package.json`'s `engines` (a non-empty object) into every task's key.

- Under `turbo()`, each task's `inputs.workspaceRuntime` holds one `awk` line. It prints that value alone, compacted, at the workspace root.
- A written config keys none.
- Raising `engines.node` re-runs every task, and no other root edit re-keys one.
- A reformat keys alike. Reordering its keys misses, where Turbo's map would hit.

## `nx()` — an Nx repo, mid-migration

`nx()` maps every project's targets from Nx's graph, until `bunx @vzn/vx-migrate` writes native config.

```ts
// .vx/workspace.ts — an Nx repo, mid-migration
import { defineWorkspace } from '@vzn/vx/config'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
```

With this file, `vx run build --all` maps every project's `build` target the way `nx run-many -t build` would.

- `nx()` is also the repo's edge source. Each project's dependencies on Nx's graph (package deps, `implicitDependencies`, imports) are its `deps`.
- So `^build` follows Nx's order with no lockfile plugin.
- The plugin reads Nx's **resolved** project graph, so nothing is re-derived here.
- In that graph Nx has already applied `targetDefaults`, expanded `namedInputs`, and inferred targets through its plugins.
- Nx has also interpolated `{projectRoot}` and friends.

**How each target runs.**

- `nx:run-commands` and a plain `command` run as one shell line that does what Nx's run-commands does (below).
- `nx:run-script` is the package script. The `$npm_package_name`, `$npm_package_version` and `$npm_lifecycle_event` it reads are defined as `<pm> run` sets them.
- A migration reads the name and version from the manifest it imports, so a bump reaches them. Any other `$npm_*` is a todo.
- `nx:noop` is a group task.
- So is a target with dependencies but neither an executor nor a command, as Nx normalizes it. One with no dependencies is dropped, as Nx drops it.
- **Every other executor runs through `nx-exec`**, with the executor and its options on the command line.

**Keys and caching.** Every target is keyed on its `inputs`.

- A target Nx does not cache is keyed on its own inputs alone, with no `^` named inputs. Nx hashes no dependency's hash into it.
- A target Nx caches (`cache: true`, or the legacy `cacheableOperations` list in `nx.json`) gets its `outputs` and `cache: true`.
- No `inputs` means Nx's `default` and `^default`.
- Named inputs resolve per project: nx.json's, under the project's own.
- `{workspaceRoot}`, `{projectRoot}` and `{projectName}` are interpolated anywhere in a path, as Nx does (`{workspaceRoot}/coverage/{projectRoot}`).
- Nx caches whichever outputs exist; vx fails a task that writes none. A `coverage` output is written only with coverage on, so the migration names it as a todo: drop it, or run the task with coverage.

<details><summary>Details</summary>

- `{options.x}` in an output is resolved. Nx 24's `{options.x ?? fallback}` is the option when set, else the fallback.
- An unset option with no fallback drops the output, as Nx does.
- A named input neither defines (such as an `extends` preset not installed) keys the whole project with a todo.
- It is never an empty list, which would key the task on its config alone.
- Nx's glob grammar is translated: `*.[jt]s` is `*.{j,t}s`.
- The default `production` negation `?(*.)+(spec|test).[jt]s?(x)` becomes brace sets, a narrowing only a negation may take.
- What has no safe form is a todo.
- A project fileset of negations alone (nx-recipes' `noMarkdown`) starts from every project file, as Nx reads it.
- A `!` acts only inside its own set. Nx hashes the `{projectRoot}` and `{workspaceRoot}` filesets apart, and vx subtracts each `!` from its whole list.
- So a `!` that may reach another set's files is dropped, which keys more, never a stale hit.
- Example: production's `!{projectRoot}/jest.config.[jt]s` beside a `{workspaceRoot}/libs/a/jest.config.ts` input keeps the file.
- An output outside the project dir is a `workspaceFiles` output. Nx's default layout puts one at `dist/<project>` in the workspace root.
- So is every `{workspaceRoot}` output of the root project, since one may lie in a nested project, which a project glob never reaches.
- Not cached: an output outside the workspace (an old generator's `reportsDirectory: "../../coverage/<lib>"`).
- Such an output is a todo and dropped, as vx caches only inside the workspace.
- An output whose first segment is a wildcard (`{projectRoot}/**/*.d.ts`) is cached.
- The committed files it reaches are kept (core never cleans one), and the rest are cleaned before the run.
- An output that covers the project's own `package.json` or vx.config is cached, with the file taken back by `!`.

</details>

**`dependsOn`** becomes the edges.

- `^build` is every dependency's `build`. It is dropped when no project has the target: Nx gives it no edges, and core refuses a `^name` nothing declares.
- `build` is this project's own `build`.
- `project:target` becomes `project#target`. Everything past `project:` is one target name, as Nx joins it.
- So `ui:build:esm` is ui's `build:esm`. `ui:build:ci` names target `build:ci`, never `build`'s `ci` configuration.
- That edge is no edge where ui lacks `build:ci`.
- This project's own target wins over a project name.
- `{ target, projects }` becomes each matched project's task.
- `projects: "self"` and `projects: "dependencies"` are read as older Nx read them (own target, `^target`), with a todo: Nx 24 refuses both at run and names `nx repair`.
- vx also keys a task on each task it depends on; Nx keys only its own inputs.
- So an input only the upstream task reads (a spec file under `gen`'s `default`) re-runs the dependant here where Nx replays it. The migration says so once.
- `inputs.tasks: []` decouples a task as Nx does, at the risk of replaying output built from an older upstream.

<details><summary>Details</summary>

- `projects` is read as Nx's `findMatchingProjects` reads it: a name, or a list of names.
- It also takes globs over names and over project directories (`libs/*`), and `name:` / `tag:` / `directory:` labels.
- A bare word matches as a word in a name, and `!` entries exclude.
- An edge to a target its project lacks is dropped without a word, as Nx drops it.
- Example: `targetDefaults` that give every `typecheck` a `codegen` one project has.
- `^name` is every dependency's `name`, whatever it holds, `^rsbuild:typecheck` included.
- A target glob (`test:e2e--*`, `^build-*`, `ui:build-{esm,cjs}`, a `{ target }` object's) expands first, over every target name in the workspace.
- Nx 19.5+ expands it the same way. A same-project glob keeps its own project's matches.

</details>

**Other inputs.**

- `{ env }` inputs go to `inputs.env`, which passes what it keys. One that is no shell variable name `sh` drops.
- `{ runtime }` inputs run at the workspace root, as Nx runs them (`inputs.workspaceRuntime`).
- In them, `{workspaceRoot}`, `{projectRoot}` and `{projectName}` are written in as the paths and name they stand for.
- Nx runs the command as written, so there `cat {workspaceRoot}/v.txt` keyed on cat's error.
- A command that exits non-zero keys its error and exit code, and the task runs on.
- Nx hashes its output whatever it exits (`git describe` in a repo with no tags). The written probe is `(<command>) || echo "exit $?"`.
- A `{ fileset, includeIgnored: true }` literal is read by such a probe. Nx 23 hashes it from disk, gitignored or missing, and vx's globs see only what git lists.
- A glob in such a fileset is a todo.

**Persistent targets.** A target that says `continuous` is a persistent task, and never cached.

- It is ready on spawn, as Nx has it: Nx starts the dependents once it has started. A run-commands `readyWhen` gates them (below).
- In a graph from an Nx older than that field, a target that runs a server executor is persistent too.
- Server executors include `@nx/vite:dev-server` and `@nx/next:server`.
- The target's name never decides: a cached `dev` caches like any other target.

**Other target fields.**

- `parallelism: false` (Nx runs the target alone) has no vx form, and is a todo naming `--concurrency 1`.
- `syncGenerators` (Nx runs them first) is one workspace note per generator list, counting its tasks and naming `nx sync`.
- nx.json's `sync.globalGenerators` is one note per run naming `nx sync`.

**Configurations.** A target with `configurations` is one task per configuration.

- `build` carries the default configuration's options, and `build:ci` the `ci` one.
- A configuration whose name another target holds is not written, with a todo, as Nx resolves `a:vite:build` to the target.
- Example: `vite`'s `build` beside an inferred `vite:build`.
- An edge of `build:ci` (own, named or `^`) reaches each target's `ci` task where it declares one, else its default.
- That is how Nx's `resolveConfiguration` does it. A `^build` there becomes one edge per dependency Nx links.

**Dependency inputs.** A `^name` input is what Nx hashes: each dependency's `name`, over the project graph, whether or not a task edge exists.

- That covers `^production`, `{ input, dependencies: true }`, and the pre-17 `{ input, projects: "dependencies" }`.
- `projects: "self"` is the own input. Nx 23 still reads both forms.
- A `{ input, projects }` list is read as `dependsOn`'s `projects` is.
- With `dependencies: true` beside it, both readings are keyed. Nx 24 reads the listed projects' dependencies' input, Nx 23 this project's `^input`.

<details><summary>Details</summary>

- Each project some reader reaches gets an `inputs:<name>` task.
- It is a no-op task (no command, nothing spawns, not counted in the run summary) keyed on its own `name` input.
- It depends on its Nx dependencies' twins. A project nothing reaches gets none.
- A task that reads `^name` depends on its direct dependencies' twins. So the whole closure goes into its key, with each project hashed once.
- A dependency fileset is keyed the same way: `^{projectRoot}/tsconfig.lib.json`, or `{ fileset, dependencies: true }`.
- Nx's own inferred `typecheck` writes such a fileset.
- Its twin is `inputs:fileset-<hash>`, since a glob's `*` is no task name. The task's description names the fileset.
- The twin keys on that fileset in each project.
- A twin lists its project's `package.json` and `project.json` first, whichever exists. Nx keys every task on its project's manifest and configuration.
- So a fileset that matches nothing (an absent `tsconfig.spec.json`, a dependency's unbuilt `*.d.ts`) is nothing to Nx.
- It gives no "matched no files" warning either, and the file appearing re-keys its readers.
- The twins spawn nothing and stay out of a run's output and task count.
- So `vx run build` counts the tasks `nx run-many -t build` does.
- A path input inside an output one of the project's own targets declares is generated.
- Example: TanStack/table's `public` input lists `{projectRoot}/dist`.
- Where Nx caches it, it is gitignored, and Nx's file map skips gitignored files.
- So Nx hashes nothing there: a changed `dist` file is a cache hit under Nx 23.3.
- So it is dropped without a todo, and the task that writes it keys its dependants through `dependsOn`.
- Only an output a committed `.gitignore` ignores drops it (one `git check-ignore` per mapping).
- `.git/info/exclude` and `core.excludesFile` do not count: they differ by machine, and the lock must not.
- An output git tracks a file under, or leaves untracked and unignored, is in Nx's file map, so the input stays.
- The exception is an input under the cached task's own output (`{projectRoot}/gen/**` beside output `{projectRoot}/gen`).
- vx cleans the output before the task runs, so core refuses such an input, which refused the whole `vx lock`.
- So it is dropped with a todo, where Nx hashes the last run's files.

</details>

| Option  | Meaning                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `root`  | Directory holding `nx.json`, relative to the workspace root or absolute. Defaults to the workspace root.                                                     |
| `graph` | An exported graph (`nx graph --file=<path>`) to read instead of keeping a snapshot; with it set the plugin never runs `nx`. Relative to `root`, or absolute. |

### Module boundaries

The `depConstraints` of `@nx/enforce-module-boundaries` in the root ESLint config become `run.rules.dependencies`.

`.vx/workspace.ts` can set its own instead. `vx lock` checks the rules over each project's workspace dependencies.

- `sourceTag` is `from`.
- `onlyDependOnLibsWithTags` is `allow`.
- `notDependOnLibsWithTags` is `deny`. An empty one says nothing and is left out.
- The config is read, never run, so a flat config's constraints must be a literal array.
- vx leaves out what it cannot express: `allSourceTags`, a `/regex/` tag, and banned external imports.
- vx checks package dependencies, not source imports, and lets an untagged project depend on anything.

### `nx:run-commands`

Nx's own option handling is rendered as one POSIX `sh` line. `vx show` prints it.

- **Where:** the workspace root, unless `cwd` says otherwise. vx has no per-task cwd, so this is a `cd` from the project dir.
- `{projectRoot}`, `{projectName}` and `{workspaceRoot}` are expanded.
- **How:** each command runs in a shell of its own.
- `commands` run in **parallel** unless `parallel: false`; parallel is Nx's default. All start at once.
- The first failure TERMs the rest, and fails the task once they have exited (exit 1, as Nx). The task succeeds once every command has.
- With `parallel: false` they run in order, and the first failure stops the rest.
- `commands: []` is a no-op that succeeds.
- **Arguments:** every option run-commands does not consume is appended to each command as `--name=value`.
- Then come `args`, then whatever follows `vx run … --`. This is per command, unless `forwardAllArgs` is false.
- `{args}` takes them in place.
- `{args.name}` is the value passed after `vx run … --` under that name, else from the target's options and `args`.
- It is spliced in as text, as Nx splices it.
- **An argument replaces its option:** an option the arguments after `vx run … --` name is not appended, as Nx drops it.
- The forms are `--region=us`, `--region us`, `--no-region`, and `-r` for a one-letter option. There is no camel-case expansion.
- The line decides once it has them. `tests/nx-run-commands-override-live.test.ts` holds it to `nx run`.
- **Environment:** `env` is `exec.env.define`, so it is in the key.
- `color: true` sets `FORCE_COLOR=true`, as Nx does.
- `envFile` is loaded after the task's `.env` files (below). A name they already set wins, as in Nx.
- **`readyWhen`** makes the task persistent with that string as its `readyWhen`, so dependents start once it is printed.
- With several strings, Nx waits for all of them. vx runs the line under `nx-env --ready-when`, one flag per string.
- `nx-env` passes the output through, and prints `nx-env: ready` once every string has appeared on stdout or stderr.
- That line is the task's `readyWhen`.
- **A leading Nx call** in a serial line, or as its one command, is a `dependsOn` edge to that target, and leaves the line.
- The forms are `nx <target> <project>` and `nx run <project>:<target>`, through `bunx`, `pnpm`, `pnpm exec`, `yarn` or npm's runner, or not.
- The edge is to the default configuration, as Nx runs it. Example: ngrx's `build` opens with `nx build-package <project>`.
- A call Nx would hand options or arguments to stays a command. So does one after another command, and one in a parallel line.
- **Reported, not reproduced:** per-command `prefix` / `color` decoration, and `streamOutput: false`.
- Decoration in a serial run (`parallel: false`), which Nx refuses, is the failing placeholder with Nx's reason, as `readyWhen` there is.
- Display-only options (`usePty`, `tty`, `verbose`) change nothing here: vx runs every task without a pseudo-terminal.

<details><summary>Details</summary>

- A forwarded argument may name an option a cached target's outputs read. That is refused, exit 2, before the command runs.
- Such an option is one in `{options.outputPath}` or `{options.outputPath ?? dist/x}`, or `outputPath` where the target declares no outputs.
- Nx resolves the outputs from that option, but vx caches the outputs mapped from the options.
- So the run would write elsewhere and save nothing, and a later hit would restore nothing.
- Set the option in a configuration instead, and run that task (`build:<configuration>`).
- An `nx:run-script` line and a translated executor's command are guarded the same way. Nx resolves their outputs from the same overrides.
- An executor line hands the names to `nx-exec` as `--outputs-option`, which refuses the same way.
- A run-commands or run-script line takes the name as typed, as Nx does: `--output-path` is not `outputPath` there.
- A translated executor's command also refuses the kebab-case spelling.
- `nx-exec` refuses each key the executor's schema names as the option (kebab-case, an alias such as `-o`), as Nx names it for the executor.

</details>

`tests/nx-exec-live.test.ts` holds each of these shapes to Nx's own run-commands executor on the same options and arguments.

### Your own executors

A workspace executor that wraps a shell command (a run-commands with your defaults) can be a command instead of an `nx-exec` line.

That spares the Node boot each `nx-exec` task pays. Pass `executors` to `nx()`, a function per executor name:

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

- Each function (`NxExecutorTranslator`) gets one target, an `NxExecutorTarget`. The option's type is `NxExecutors`.
- The target holds `executor`, `project`, `projectRoot` (workspace-root-relative), `target`, `configuration` and the resolved `options`.
- `configuration` is set for a `<target>:<configuration>` task.
- The function returns an `NxExecutorTranslation`, `{ command, timeout?, env? }`.
- `command` runs in the project dir. `timeout` is `exec.timeout`, a duration with its unit (`'10m'`).
- `env` is defined as a run-commands `env` is, and the target's `.env` files load as for a run-commands line.
- Returning `undefined` runs that target through `nx-exec`, as for any executor not named.
- Inputs, outputs (cleaned before each run), `dependsOn` and caching come from the graph, as for every target.
- `nx:run-commands`, `nx:run-script` and `nx:noop` (and their legacy names) are translated by `nx()` itself, and are refused here.
- So is a return that is not `undefined` or a valid translation.
- A function's source text keys the cached mapping, so it should depend on its argument alone.
- `bunx @vzn/vx-migrate` writes executor targets as `nx-exec` lines regardless.

### `.env` files

Nx loads a task's `.env` files into its environment, unless `NX_LOAD_DOT_ENV_FILES=false`. `nx()` does the same.

- The project's files come before the workspace root's.
- The most specific name comes first: `.env.build.production.local`, `.env.build.production`, …, `.env.local`, `.local.env`, `.env`.
- A grouped target's files are named by its group's owner and parent.
- Example: cypress's atomized `e2e-ci--a.cy.ts` loads `.env.e2e-ci` and `.env.e2e`.
- The first file to define a name wins, and the environment wins over every file.
- The lock is the same on every machine, so `nx()` never asks the disk which files exist.
- An executor line passes every candidate name to `nx-exec` as `--dotenv <file>`, as Nx does.
- A shell line runs under `nx-env --dotenv <file>… --`, with every candidate, only when git tracks one of them.
- A shell line whose only `.env` files are not committed loads none. `vx lock` names those files: commit them, or load them in the command.
- The bins load whichever candidates exist when the task runs, with Nx's own parser.
- They read `NX_LOAD_DOT_ENV_FILES` there too. It is passed to the task and keyed.
- Their values never enter a config, so a `.env.local` secret is not in `vx show`, `.vx/projects.lock` or a migrated `vx.config.ts`.
- A cached task keys the candidates as literal inputs: the project's in `inputs.files`, the root's in `inputs.workspaceFiles`.
- A literal is keyed present or not, and gitignored or not, so adding, editing or removing one is a miss.
- `tests/nx-exec-live.test.ts` compares what the line sees with what `nx run` gives the same target.

### The target a task sees

A task whose command still runs or names Nx or Lerna (`nx-exec`, `nx-env`, `nx exec`, `lerna`) gets Nx's task variables. Nx hands them to every task.

- They are `NX_TASK_TARGET_PROJECT`, `NX_TASK_TARGET_TARGET` and `LERNA_PACKAGE_NAME`, all in `exec.env.define`.
- `LERNA_PACKAGE_NAME` is the project, which Lerna on Nx's runner documents to scripts.
- Where the task runs a configuration, it also gets `NX_TASK_TARGET_CONFIGURATION`.
- A run-commands `env` wins. Any other task gets none.
- Nx's own `npm:public` / `npm:private` tags are not written.
- A package script's `nx exec -- <cmd>` reads these variables.
- Without them it starts Nx's own task runner, which runs the target and its dependencies again.

### Inputs that key nothing here

Some Nx inputs have no vx form, or need none.

Nx hashes the root TypeScript config (`tsconfig.base.json`, else `tsconfig.json`) into every task.

So every mapped task lists it in `inputs.workspaceFiles`, and a `compilerOptions` edit re-runs it, as under Nx.

vx keys the whole file, where Nx leaves other projects' `paths` entries out. So a `paths` edit re-runs every task.

`{ dependentTasksOutputFiles }` hashes the outputs of the tasks a target depends on.

- vx hashes those tasks' keys into it through `dependsOn`, and a cached task's output follows from its inputs.
- An uncached producer's output does not. Example: a `cache: false` `fetch` that writes a gitignored schema from outside.
- There the files the glob names under its outputs are an `inputs.workspaceRuntime` probe.
- `inputs.tasks` leaves the producer out, so core answers the probe after it ran, as for `turbo()`'s `dependencyOutputs`.
- An output the probe cannot list (a wildcard directory) leaves the reader uncached with a todo.
- With `transitive: true` the reader reads every task below it. So an uncached producer behind an `nx:noop` group or another task counts too.
- Then the direct edge it sits under is left out instead, and the probe lists every output below that edge.
- A target may read them with no `dependsOn` edge left to a migrated task. Its producer is then a project vx did not migrate, such as a .NET project.
- That target is written uncached, with a todo naming the producer: its key would see nothing it reads.
- A `^build` edge on a project Nx links to no dependency (a leaf library's inferred `build`) reads nothing, and stays cached.

`{ workingDirectory }` hashes the directory Nx was started from. A vx task runs in its project dir from wherever vx is started.

Neither `dependentTasksOutputFiles` nor `workingDirectory` is a todo.

`{ externalDependencies }` hashes the named packages' resolved versions, and core keys no lockfile.

- A `@vzn/vx-lockfile` plugin keys each task on its project's and the root's dependencies.
- So a name the root `package.json` declares needs nothing there, and any other is a todo.
- `nx()` reads the workspace's plugins' `fingerprint` claims. With no plugin claiming the root lockfile, the task lists the lockfile in `inputs.workspaceFiles`.
- That is a superset: any edit to the lockfile re-runs the task, as a `left-pad` bump re-runs it under Nx.
- Under Nx 24, a target with no `externalDependencies` input of its own hashes every external dependency (`AllExternalDependencies`).
- The exception is an `@nx/` or `@nrwl/` executor, which hashes its own package.
- With no plugin claiming the lockfile, such a target lists the lockfile too.

### The environment a task sees

Nx hands every task its whole environment. vx hands a task only what it declares.

- Its essentials reach it: `PATH`, `HOME`, `CI`, `NODE_OPTIONS`, ….
- So do the names its Nx `{ env }` inputs declare, which also key it.
- So does what `nx()` defines: the target, `.env` files, a run-commands `env`.
- A variable set in the shell and read by no declared input, such as `NODE_ENV` or `DATABASE_URL`, does not reach the task.
- Declare it as an `{ env }` input of the target in the Nx config.

### Atomized targets

Two cached tasks on one workspace path cannot both keep their cache, and the first declared is kept.

- Cypress's atomizer gives `e2e` the whole `videos` dir, and each `e2e-ci--<spec>` a subdir of it.
- So `nx()` also tries the split target (a `nonAtomizedTarget`) last, and keeps the order that caches more tasks.
- Each spec's CI task keeps its cache, and `e2e` runs uncached, with the todo.
- Where the specs share the split target's one path (jest's coverage dir), the declared order stands.

### nx.json `parallel`

`parallel` (or the legacy `tasksRunnerOptions.default.options.parallel`) is the run's `run.concurrency` when `.vx/workspace.ts` sets none.

`NX_PARALLEL` (a count or `50%`) wins over it, as in Nx. So a repo that sets `1` for a shared resource keeps one task at a time.

### nx.json `defaultBase`

`NX_BASE` is the run's base commit (`setBranch({ base })`).

`defaultBase` is `baseBranch` when `.vx/workspace.ts` sets none. Nx 19 called it `affected.defaultBase`; an `origin/` prefix is dropped.

So a bare `vx run test --affected` compares with the ref `nx affected` does.

### nx.json `maxCacheSize`

`maxCacheSize` maps to nothing: no vx run evicts, `vx cache clean --max-size` does.

### Lerna

`lerna run build` runs each package's `build` after its dependencies' `build`. Lerna 6+ runs it on Nx's task runner.

- That holds unless the repo configures Nx's task dependencies.
- Those are nx.json `targetDefaults` (or the legacy `targetDependencies`), or an `nx` key in the `package.json` of a package that has the target.
- Beside a `lerna.json` with neither, each target's `dependsOn` is its `^` self (`build` → `^build`), in place of any other.
- That is how Lerna hands it to Nx; the exported graph holds no such edge. A migration writes the same.

### Project tags

An Nx project's `tags` are its vx `tags`.

- So `vx run build --filter tag:scope:web` (or Nx's `--projects tag:scope:web`) selects what `nx run-many -t build -p tag:scope:web` does.
- A package whose `vx.config` declares `tags` keeps its own.
- A blank tag is dropped, since vx refuses one.

### The graph snapshot

Once per `vx lock`, the plugin keys its snapshot of Nx's graph, `<cache dir>/nx-project-graph.json`. No run maps.

The key is what Nx computes the graph from:

- `nx.json`, and the files its `extends` chain names, by content.
- The worktree as git sees it: `HEAD` and `git status -uall`.
- The content of every listed path under a project root, the last graph's roots too. So a project `discover` names counts before it is one.
- Any `project.json` or `.gitignore`, since Nx's project walk honours each one.
- Root files: manifests, lockfiles, `tsconfig*.json`, and the tool configs an inferring `@nx/*` plugin reads.
- Anything in the directory of a local plugin `nx.json` names by path (`./tools/plugin.js`). At the root, that is the file itself, any extension.

The files an inferred target came from (its `vite.config.ts`) are Nx's `source-maps.json`, in `.nx/workspace-data`.

Or they are where `NX_WORKSPACE_DATA_DIRECTORY` (or the older `NX_PROJECT_GRAPH_CACHE_DIRECTORY`) points, as for Nx.

<details><summary>Details</summary>

- The git status is core's own for the run (`DiscoverContext.worktreeChanges`), so the tree is walked once. Walking it again took ~96 ms per run on refine.
- A `root` elsewhere asks git itself.
- The tool configs are `jest.config.*`, `jest.preset.js`, `.eslintrc*`, `eslint.config.*`, and the configs of `vite`, `vitest`, `playwright`, `cypress`, `webpack`, `rollup`, `rspack` and `next`.
- Another root file a plugin reads moves the snapshot once committed, since `HEAD` moves.
- So does a plugin named by package or path alias that sits outside every project root.

</details>

A different key, or no snapshot, runs `node_modules/.bin/nx graph --file=<snapshot>`.

- That is the one time Nx itself runs. It is served from the daemon when one is up.
- So a source edit that adds a cross-package `import` (an edge Nx derives) re-exports at the next `vx lock`, tracked or untracked.
- So does a config an Nx plugin infers targets from (`vite.config.ts`).
- A touch without an edit, or a stray file a task writes at the root, does not.
- Outside a git worktree the plugin falls back to the manifests' mtimes.
- A run never exports, maps or reads the graph. `vx lock` records the projects the `discover` stage names and the edges Nx derives (`implicitDependencies`, an `import`).
- So a `project.json` edit, a new edge included, changes what runs only after the next `vx lock`. Until then a run on this machine refuses, naming the file.
- So does a new `project.json`, or an edit to the file an inferred target came from (`vite.config.ts`).
- Nx records that file in `.nx/workspace-data/source-maps.json` (or under `NX_WORKSPACE_DATA_DIRECTORY`, as in Nx).
- With `graph:` set Nx may record none; then an inferred-config edit needs `vx lock` by hand.
- A source `import` is not refused; `vx lock --check` names it.
- That holds under `vx watch` as in a run: a re-lock is the next cycle's event.

<details><summary>Details</summary>

- Where the root links no `nx` (a Lerna repo on pnpm), it uses the `nx` Lerna depends on, which `lerna run` runs.
- That goes through Nx's `createProjectGraphAsync`, as Lerna calls it. Nx 20+'s bin refuses a root `nx` does not resolve from.
- The snapshot and its key live in the cache dir, which ignores itself (a `*` `.gitignore` inside it). So writing them moves nothing.
- Nx's own caches (`.nx/cache/`, `.nx/workspace-data/`, which the export writes) never enter the key.
- Otherwise, under a root project (a standalone repo) that does not ignore them, each export would re-export on the next run.
- An export that fails with a snapshot in hand warns, and goes on with the previous graph.
- The snapshot is machine-local, like the cache: nothing about it enters a key.
- Measured at 1,000 projects, the export runs once: 1.5 s with the daemon off after an edit, 0.9 s with it on. That is Nx's own computation.
- A `vx lock` with nothing changed pays the key, 43 ms at min, where the manifest stats it replaced took 9. It also pays the mapping.
- A run pays neither.
- The mapping itself is kept beside it, in `<cache dir>/vx-migrate-nx-mapping.json`, keyed on everything it reads.
- It reads the graph, `nx.json` and its `extends` chain, every package manifest, and each project dir's `.env` names.
- It also reads which bins are installed, the files git tracks, and the mapper's own code.
- So a `vx lock` with nothing changed maps nothing.

</details>

### What it does not do

- A task the package's own `vx.config` already declares is left alone: the plugin fills, it never overwrites.
- Migrate a package by writing its config. The rest of the repo keeps running from the graph.
- Each package-manager member is a project through core's `discover` stage, named by its `package.json`.
- Core alone finds only directories holding a `vx.config`.
- An Nx project no workspace package matches is made a project the same way.
- Examples: the root project, or an integrated repo's `project.json` library no package glob lists (analogjs).
- It is named by its `package.json` name, else its Nx name. Its targets attach there by directory, and no `vx.config` is needed.
- A project whose name a package already holds, or whose directory is gone, has nowhere to go.
- `vx lock` reports it; run its targets with `nx`.
- A `^target` only such a project declares is no edge, as under Nx.
- An explicit edge to one of its targets is dropped with a todo, rather than refusing the run. The key misses that target.
- A negated output (`!{projectRoot}/dist/cache`) takes its path back from the positive ones.
- A cached target with no `outputs` takes what Nx caches for it: `options.outputPath`, each path of a list.
- Without one, for `build` and `prepare`, it takes `dist/{projectRoot}` and `{projectRoot}/dist`.
- Nx's `{projectRoot}/build` and `{projectRoot}/public` are outputs too when git tracks nothing under them; one that holds a tracked file is a todo.
- That is because vx cleans an output before the run.
- Nx keeps whichever of these exist, so each maps as the tree under it (`dist/**`): it may match nothing, as long as the build writes one of them.
- Nx adds an `nx-release-publish` target (`@nx/js:release-publish`) to every project with a `package.json`.
- It comes along as one `nx-exec` task per package, run only when asked (`vx run nx-release-publish --filter <pkg>`).
- It counts in `vx info`'s task total.
- A migration does not write it. Nx release's publish step skips a private package and a published version, and rewrites `workspace:` ranges.
- No one line does that, so the report has one note naming the package manager's own `publish`.
- `nx-exec` and `nx-env` must be on every task's PATH.
- They are when `@vzn/vx-migrate` is a devDependency of the workspace: its bins land in `node_modules/.bin`.
- A plugin loaded by path warns at `vx lock` when they are not.
- Both load Nx from the workspace, so a repo run from an exported `graph` with no `node_modules/nx` warns once too.
- A `dependsOn` entry's `params: "forward"` (the run's arguments) and `options: "forward"` hand the dependency overrides.
- `options` there is this target's options, its configuration's merged in.
- That is a different command than vx's one task per target, so each is one todo per task.
- The todo names no dependency, so a run's warnings group them (an atomized `e2e-ci` forwards to every spec).
- `options` is a todo only when there are options to forward.
- Batch executors run one task per process.
- An executor that reads `context.taskGraph` under `NX_BUILDABLE_LIBRARIES_TASK_GRAPH` sees none, and takes Nx's project-graph path.
- The mapping's gaps are the migration's gaps. `vx lock` reports them as warnings, once for all the tasks that carry each one.
- `vx lock` also warns of what this machine lacks to run them: the `nx-exec` bin, `node_modules/nx`, a graph export that failed.
- A run maps nothing, so it never warns of these.
- `bunx @vzn/vx-migrate --dry --from nx` lists the same set once.

## `nx-exec` — one Nx executor, one process

`nx-exec` is a bin this package installs. `nx()` runs it for every executor target.

```sh
nx-exec <executor> --project <name> --target <name> [--configuration <name>] [--options '<json>'] [--dotenv <file>]... [--outputs-option <name>]... [overrides…]
nx-env [--dotenv <file>]... [--envFile <file>] [--ready-when <string>]... -- <command> [args…]
```

- It runs under the workspace's Node, since executors are Node programs.
- It resolves `nx` from the working directory up to the workspace's `node_modules`.
- It reads Nx's cached project graph for the `ExecutorContext` executors expect: the project root, and dependencies for buildable libraries.
- When that cache is missing or lacks the project, it computes the graph in-process, as `nx run` does, never through the daemon.
- It **replaces** that project's target in the in-memory graph with the executor and options given.
- It calls Nx's own public `runExecutor`, so Nx's option merging, schema defaults and validation run unchanged.
- The executor runs from the workspace root, where Nx forks one, though vx starts the task in its project dir.
- So an executor that resolves against `process.cwd()` (@nx/js's ts transformers, prettier's config) sees what it sees under Nx.

<details><summary>Details</summary>

- Anything else on the line is an override: what `vx run <target> -- --otp=123` appends.
- Nx's own `createOverrides` parses it, and the executor gets it as `nx run <p>:<t> --otp=123` would hand it.
- `--dotenv` files are loaded into its environment first (see `.env` files above).
- An override of an `--outputs-option` exits 2 with a message naming it, before the executor runs (see Arguments above).
- The exit code is the outcome `nx run` reports: the executor's returned result when it returns one, else its last yielded result.
- A server executor keeps the process alive for as long as it yields.
- A thrown error (an executor's own, or a missing executor package) exits 1 with its message.
- Its stack prints only under `NX_VERBOSE_LOGGING=true`, as `nx run` reports one.
- An executor package that is not installed is one line naming it.
- The bin enables Node's on-disk compile cache for its own process (Node ≥ 22.1, a no-op below).
- That takes about 30 ms off every executed task after the first.

</details>

`nx-exec` sets `NX_DAEMON=false` unless set: it never dials the daemon.

It sets `NX_ISOLATE_PLUGINS=false` unless set, so plugins load in its own process, and a sandbox needs no socket.

`NX_VERBOSE_LOGGING=true` is the context's `isVerbose`.

`nx-env` loads the `.env` files and a run-commands `envFile` with Nx's own functions. Then it runs the command with `sh -c`.

Whatever follows the command is appended, as vx appends forwarded arguments. Its exit is the shell's.

With `--ready-when`, the command's stdout and stderr pass through unchanged. `nx-env: ready` prints once every string has been seen, one split across two writes included.

Why the command carries the options:

- vx's key sees them, so resolved-config hashing holds.
- No ambient state decides what runs.
- `vx show` prints the truth, and the line pastes into a shell.

Each executed `nx-exec` line still loads Nx's own module graph: about 220 ms, on a miss only.

It is a bridge: the bare command that replaces it in native config pays none of that. The design is in `docs/design/nx-unchanged-2026-09.md`.

## `bunx @vzn/vx-migrate` — write the configs

`bunx @vzn/vx-migrate` writes your vx config from what the repo already has.

```bash
bunx @vzn/vx-migrate           # auto-detect: turbo.json, .nx/workspace-data/project-graph.json, nx.json or lerna.json, then vite-plus, else package.json scripts
bunx @vzn/vx-migrate --dry     # print the generated files + the report instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.*
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
bunx @vzn/vx-migrate --from vite-task # Vite Task beside turbo.json or Nx
bunx @vzn/vx-migrate --from scripts   # package.json scripts beside any of them
bunx @vzn/vx-migrate --native  # write vx.config.ts files without asking
bunx @vzn/vx-migrate --keep    # keep turbo.json / nx.json as the source: turbo() or nx(), with its plugins
bunx @vzn/vx-migrate --help    # the usage, exit 0
```

It is the one command a repo needs. `pnpm dlx @vzn/vx-migrate` in a pnpm repo works the same.

**Native or keep.** In a Turbo or Nx repo, in a terminal, it asks which adoption you want.

- **native** (the default) writes a `vx.config.ts` per package.
- **keep** writes a workspace file declaring `turbo()` or `nx()`.
- `--native` / `--keep` answer the question. With no terminal (CI, a pipe) it is native.
- Elsewhere both flags are refused.
- A repo already set up (a workspace file declaring neither, and project configs) is reported as set up, exit 0, unless `--force`.

**Remote cache.** Native or keep, a remote cache the repo shows is declared. The report names the file that showed it.

- `turboCache()` is declared for turbo.json's enabled `remoteCache`, or a `turbo link`ed `.turbo/config.json`.
- It is also declared for a CI file (`.github/workflows/*`, `.gitlab-ci.yml`, `.circleci/config.yml`) setting `TURBO_TOKEN`.
- `nxCache()` is declared for a CI file setting `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`.
- Nx Cloud (`nxCloudId`, `nxCloudAccessToken`, the `nx-cloud` runner) is named instead: vx does not speak its wire.

**The workspace file.** With no `.vx/workspace.*` yet, it writes one declaring the plugins the repo calls for (`src/workspace-plugins.ts`).

- It declares the remote cache above.
- It declares the `@vzn/vx-lockfile` factory for the lockfile: `bun()`, `pnpm()`, `npm()` or `yarn()`. With no lockfile yet, it picks the one its install writes.
- It declares `vxHistory()`.
- From `@vzn/vx-ci`, it declares `github()` when `.github/workflows` exists, and `gitlab()` when `.gitlab-ci.yml` does.
- A remote cache on CI reads the refs those plugins name.
- Each is installed beside `@vzn/vx`, at vx-migrate's own version.
- Keep adds them to the file it writes, or to one already in that shape. Any other workspace file is yours, and is left alone.
- Native over a file vx wrote (a keep adoption's) rewrites it.
- There `turbo()` and `nx()` go, since the configs written replace them, and the other plugins stay.

**Installs.** It installs what the written files import, with the repo's own manager (`packageManager`, else the lockfile).

- That is `@vzn/vx`, and every `@vzn/vx-*` package the workspace file imports, one an earlier init wrote included.
- It also installs `@vzn/vx-migrate` for keep, or when a written task runs its `nx-exec` or `nx-env` bin.
- `--no-install` skips installs and removals.

<details><summary>Details</summary>

- The install commands are `pnpm add -D -w` in a pnpm workspace (no `-w` in a lone package), and `bun add -d`.
- They are also `yarn add -D -W` on Yarn 1 (no `-W` on Yarn 2+), and `npm install -D`.
- Under pnpm, a plain `pnpm install` follows each add or remove.
- pnpm's `add` can leave a peer set linked that its new lockfile no longer names, which the lockfile plugin refuses.
- A package the root both lists and has installed at vx-migrate's own version is left alone. Any other is installed at that version.
- So is every other `@vzn/vx-*` plugin the root lists from the registry: one install moves them together, as `vx upgrade` does.
- Native removes a listed `@vzn/vx-migrate` when nothing written needs it.
- That means no `nx-exec` / `nx-env` task, and no `turboCache()` or `nxCache()` left in the workspace file.
- The removal commands are `pnpm remove` (`-w` in a pnpm workspace), `yarn remove` (`-W` on Yarn 1), `bun remove`, and `npm uninstall`.
- An install or removal that fails does not stop the migration.
- The manager's output prints, the report's `failed` row names the command, and the files are still written. vx-migrate then exits 1.
- vx-migrate runs only with the `@vzn/vx` of its own release, which it installs.
- One of another release is refused, naming where it was loaded. A `bun x` install directory keeps the one it had.

</details>

**The lock.** Native, once the files are written, it ends with `vx lock`.

- `.vx/projects.lock` is written and the graph rules are checked. Its line is the report's `lock` row.
- A refusal prints above the report, the configs stay written, and vx-migrate exits 1, as `vx init` does. A run reads only the lock.
- `--no-install` skips the lock, since the plugins the workspace file declares are not installed yet. `next` then starts with `vx lock`.

**Lerna.** A Lerna repo is an Nx one: Lerna 6+ runs `lerna run` on Nx's task runner, over the graph `nx graph` exports, nx.json or not.

- So a `lerna.json` with no nx.json and no turbo.json is mapped from that graph. Keep writes the workspace file declaring `nx()`.
- Lerna is the installed one, else the root manifest's range.
- With neither, the lerna.json is another tool's: lerna-lite reads it too, and runs no Nx.
- A root whose scripts never `lerna run` runs its tasks another way, and publishes with Lerna (webdriverio: `run-s`, `pnpm -r`).
- Its scripts stay the source.
- So do the scripts of a repo where Lerna runs its own runner: `useNx: false`, or Lerna 5 without `useNx: true`.
- Beside turbo.json, Turbo runs the tasks and Lerna only publishes, so turbo.json is the source.

**Flags and files.** Your `package.json` scripts are never edited.

- `--dry` prints the files instead of writing them. It installs nothing, and says what it would install.
- `--force` overwrites existing `vx.config.*` files. A hand-written `.vx/workspace.*` stays; only `--keep --force` replaces it.
- `--mjs` writes `vx.config.mjs` instead of `.ts`: the same objects with no type import and no `satisfies`.
- Use `--mjs` for a package whose own `tsconfig` includes every `.ts` under it, and would compile the config into its dist (TanStack/query).

Every source hands a plan to core's `applyMigration` (from `@vzn/vx`). It renders, refuses to overwrite without `--force`, writes and reports.

No file is written through a symlink, `--keep`'s workspace file and `.vx/.gitignore` included.

A target that is a link, a dangling one too, is refused before anything is installed or written.

Anything a source cannot say becomes a `TODO(vx-migrate)` comment, never a silent wrong value.

**The report** reads like a run's footer: a blank line, the `─ vx-migrate <version> ───` rule, then one dim label per row, each fact once.

- `from`: the source.
- `ran`: each install or removal command.
- `tasks`: clean in green, todo in yellow.
- `todo`, `files`, `kept`, `replaced`, `lock` and `note`.
- Last, after a blank line, `next` in bold.

A terminal sees the install command while it runs, on a line the report replaces. The manager's own output prints only when it fails.

### Turbo

The CLI reads the root pipeline (`tasks` in Turbo 2, `pipeline` in Turbo 1), per-package `turbo.json` `extends` overlays, and each package's scripts.

It uses the same mapper `turbo()` runs at `vx lock`, so the written configs say what the plugin was doing.

- Each written config holds only what its tasks declare, and imports no shared file.
- turbo.json's global block (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`, Turbo 1's `globalDotEnv`) goes onto no task.
- Nor do Turbo's implicit hash inputs: the root's dependencies and `engines`, and its default and builtin env.
- When turbo.json writes a global field, a note names its values.
- Every task with a command then gets a TODO to list what it reads in its own inputs. The report lists those by `project#task`.
- Turbo's `//#` root tasks are written to a `vx.config.ts` at the workspace root.
- That makes the root a project, and a package task's `//#x` edge reaches it.

<details><summary>Details</summary>

- A long value is named once at the top of the config that uses it.
- That is a `.env` probe (`dotenvFiles`), or a task's `env` that several configs share (`buildEnv`).
- Example: vercel/ai has 63 such names, twice in each of ~100 configs.
- When a `.vx/workspace.ts` already exists without a lockfile plugin, the report names the `@vzn/vx-lockfile` plugin for the repo's lockfile.
- Turbo keys each package on its own lockfile entries, and core keys no lockfile.
- So until a plugin owns the lockfile, a dependency bump re-runs nothing.
- The written workspace file may declare no lockfile plugin (`--no-install`, and no lockfile yet).
- Then a note says `^build` has no project edges until one is installed and declared. The scripts mapper does the same.
- With no lockfile plugin, nothing names a project from its manifest.
- So the report names each project as vx does: `//` for the root, else its path (`packages/a#build`).

</details>

| Turborepo                           | vx                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `dependsOn`                         | `dependsOn`, same micro-syntax (`$TURBO_ROOT$` deps are a TODO)                                                                |
| `inputs`                            | `inputs.files` (`$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/x` → `workspaceFiles`)                                               |
| `outputs`                           | `outputs.files`, a negated one included                                                                                        |
| `env`                               | `inputs.env`, which the task also sees (child envs are isolated)                                                               |
| `passThroughEnv`                    | `exec.env.passThrough`                                                                                                         |
| `cache: false` / `persistent: true` | no `cache: true`, still keyed on its `inputs`; `exec.persistent: {}`, with a TODO to set `readyWhen` when a task depends on it |

### Nx

The CLI reads the **resolved** project graph only, through the same mapper `nx()` runs live, executors aside (below).

- The graph is the one the workspace's own `nx graph` exports into a temp file, as `nx()` does.
- Nx leaves its last graph in `.nx/workspace-data/project-graph.json`, which may predate an edit. It is read only with no `node_modules/.bin/nx`.
- With neither, as in a fresh clone, it stops and names the package manager's install.
- Targets Nx plugins infer at runtime are frozen as the snapshot saw them.

**How targets are written.**

- `nx:run-commands` is the one shell line `nx()` runs. See [`nx:run-commands`](#nxrun-commands) above: where, parallel or in order, forwarded arguments, `env`, `readyWhen`.
- Example: storybook's `compile` is `cd ../../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli`.
- A plain `command` is that shorthand.
- `nx:run-script` is the package's script body with its `pre<name>` / `post<name>` hooks joined in.
- It is `yarn run <name>` when the body calls yarn's `run` builtin. An empty script is the placeholder with a todo.
- `nx:noop` is a group task.
- Nx 15–16's `@nrwl/workspace:run-commands` and `run-script` (and their `@nx/workspace:` names) are the `nx:` executors they re-exported.
- **An executor target is its `nx-exec` line**, as `nx()` runs it. The migrator translates no executor.
- So Nx and `@vzn/vx-migrate` stay installed until you rewrite each such line as the command it runs.
- A server executor Nx knows (`@nx/js:node`, or a dev server) is still a persistent task.

**What the report adds.** The report also says what `.vx/workspace.ts` still holds, as the Turbo migration does.

- It names the `nx()` a keep adoption declared, which keeps reading nx.json.
- It names a lockfile with no `@vzn/vx-lockfile` plugin, where Nx keyed each project on the npm packages it depends on.
- A written command that still runs Nx itself carries a TODO: it works only while Nx is installed.
- Examples: a run-commands `nx run b:build`, `pnpm exec nx test b`, a script's `nx exec -- tsc`.
- What `echo` or `printf` prints is text, not a call.

<details><summary>Details</summary>

- An Nx project no package-manager member holds (an integrated repo's `project.json` library) is found by its vx.config, as every project is.
- Its config writes the project's Nx `name`, which its dependants spell, and nothing else changes.
- No `package.json` is written, and no workspace glob asked for.
- In a single-version repo, a listed library would make the manager install its own ranges.
- Its dependencies resolve from the root, whose lockfile entry keys it.
- A repo with no `package.json` at all is migrated too, natively only.
- That is Nx's `nx init` outside JS: Nx pinned in `.nx/installation`, projects as `project.json`.
- There the root is the directory holding `nx.json`, and `.nx/installation`'s `nx` exports the graph.
- Each config writes the project's Nx `name`. Every edge is the explicit `project#target` Nx's graph draws.
- A `^` edge would need a lockfile plugin, which has no lockfile to read there.
- `.vx/workspace.ts` declares no plugin, so nothing is installed and core runs the configs alone.
- `--keep` refuses, as `nx()` would have no `package.json` to install into.
- An executor target's `nx-exec` line is a note to rewrite as a command.

</details>

**Other fields.**

- A target with `configurations` writes one task per configuration (`build`, `build:ci`).
- A project's Nx `tags` are written as its `tags`.
- Named inputs expand from `nx.json` when readable.
- nx.json's `parallel` and `defaultBase` and the ESLint module boundaries, which `nx()` applies live, are each a field of the written `.vx/workspace.ts`.
- The fields are `run.concurrency`, `baseBranch` and `run.rules`. They are read from nx.json alone, never the environment.
- Beside a workspace file already there, each is a note naming the field to add.

**Outputs.** An output path is kept as written, a `!` one too: `{projectRoot}/dist` is `dist`, `{projectRoot}/bin/tool` is `bin/tool`.

- vx reads a bare path as the file or the whole tree under it. So a directory and an extensionless binary both save and restore.
- One naming an unset `{options.x}` is dropped, as Nx drops it.
- A dotted `{options.outputPath.base}` walks the options, as Nx does.

<details><summary>Details</summary>

- An extglob is put in vx's grammar. Next's inferred `.next/!(cache)/**/*` is `.next/*/**/*` with `!.next/cache/**/*`.
- `@(js|map)` is `{js,map}`, and Nx's bare group `*.(js|map)` is `*.{js,map}`, in inputs and outputs alike.
- A form with no vx spelling is dropped with a TODO.
- A `**` glued to text, in an output or an input, is one `*`, as Nx reads it: `src/**.ts` is `src/*.ts`.
- Nx caches a directory a glob matches whole.
- So an output ending in a lone `*` (`dist/*`) also writes the trees under its matches (`dist/*/**`). Read as files alone, a hit dropped `dist/sub/`.
- The whole project (`{projectRoot}`, `{projectRoot}/**`, `{projectRoot}/**/*`) is `*` with `*/**`: the same files.
- That is because core refuses `**` beside the default `**/*` inputs as the task's own sources.
- This was checked against Nx 24.0.2: miss, delete, and a hit restores the same files.

</details>

**Edges.** vx derives package edges from `package.json`.

- An Nx graph edge with no manifest path (`implicitDependencies`, a tsconfig path) needs more.
- For each `^target` of the dependant, it becomes an explicit `pkg#target` edge to what Nx's own walk reaches. So the order and the key are Nx's.
- That walk reaches each dependency that has the target, and through one that lacks it, its dependencies.
- The reverse too: a project's manifest may name a workspace package its Nx graph does not reach.
- Example: an `implicitDependencies: ["!a"]` that breaks a manifest cycle.
- There its `^target` becomes the explicit edges Nx draws, since vx's `^` would follow the manifest and bring the cycle back.

### Vite Task

Vite Task is detected when the root `package.json` lists `vite-plus`, after turbo.json and Nx.

vite-plus is a whole toolchain, so a repo with either of those runs its tasks there. `--from vite-task` picks Vite Task anyway.

There is no live plugin, so `--keep` is refused.

- Each package's `vite.config.*` (in vite-plus's file order) is loaded by Bun as `vp run` sees it. A function config is called in build mode.
- Its `run` block is mapped with the package's `package.json` scripts, which `vp run` runs too.
- The root package's tasks and scripts (`vp run -w`) make it a project when it has a `name`.
- A command that opens with `vp run` (or `vpr`) is inlined as Vite Task inlines it.
- `vp run x`, `pkg#x`, `-r x`, `-w x` and `-F <name> x` are `dependsOn` edges.
- `-r` is an edge to each package with `x`, the task's own reference pruned.
- The task runs nothing when nothing follows them: a no-op task of its `cache.input`, or a group with none. Its `cache` and outputs are dropped.
- The edges run in parallel where Vite Task ran a chain in order.
- Any other form stays in the command with a TODO: `--parallel`, `-t`, forwarded arguments, or a `vp run` after another command.

| Vite Task                                                 | vx                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` (a string, or an array run in order)            | `exec.command`, the array joined with `&&`; `command: []` is a group task                                                                                                                                                    |
| `cwd`                                                     | `cd <cwd> && ` before the command                                                                                                                                                                                            |
| `dependsOn: 'x'` / `'pkg#x'`                              | the same                                                                                                                                                                                                                     |
| `dependsOn: { task, from }`                               | `^task`; when a member listed under a field `from` leaves out also has the task, the explicit `pkg#task` edges, since `^` follows every field                                                                                |
| `cache.input` / `cache.output` globs                      | `inputs.files` / `outputs.files`; `base: 'workspace'` → `workspaceFiles`, a root task's too; a `**` glued to text (`src/**.ts`), which vx refuses, widens an input to `**/*` and runs an output's task uncached, with a todo |
| omitted or `{ auto: true }` (traced files)                | no `cache: true`, with a TODO: vx infers no inputs or outputs                                                                                                                                                                |
| `cache.env`                                               | `inputs.env`, which the task also sees; a `*` entry kept as written, matched by each run; a `!` entry drops its literal, and is a TODO when a kept pattern still matches it                                                  |
| `cache.untrackedEnv`                                      | `exec.env.passThrough`, wildcards as `cache.env`                                                                                                                                                                             |
| `cache: false`, root `run.cache` `false` / `tasks: false` | no `cache: true`                                                                                                                                                                                                             |
| a `package.json` script                                   | a task, uncached; with root `run.cache.scripts` a TODO for its cache                                                                                                                                                         |
| `run.enablePrePostScripts` (default `true`)               | a script's `pre<name>` / `post<name>` joined into its command; `false` keeps them tasks of their own                                                                                                                         |

### package.json scripts

Where no runner's config is the source (or under `--from scripts`), each package's `package.json` scripts become its `vx.config.ts`.

For example, `"build": "tsc -b"` becomes a `build` task that runs `tsc -b` after its dependencies' builds, with a TODO to set its cache.

**The workspace file.** It also writes a `.vx/workspace.ts` that declares the `@vzn/vx-lockfile` plugin for the lockfile at the root.

- Package edges (`^build`, `--affected`) come from that plugin.
- The plugin is `bun()`, `pnpm()`, `npm()` or `yarn()`. With no lockfile yet, it is the one its install writes.
- Under `--no-install` the file holds `{ plugins: [] }`.
- When `@vzn/vx-lockfile` is not installed, it installs it with that manager, pinned to its own version, before `vx lock` runs.
- `--dry` names that install command instead.
- A workspace file already there is left as it is.

<details><summary>Details</summary>

- With no plugin declared there are no package edges. A workspace's report names the install and the plugin `^build` needs.
- Its `project#task` ids are then vx's: `//` for the root, else the package's path.
- A lone package's tasks get no `^` edge, whatever the workspace file declares: there is no other package to build first.
- (`vx init`'s workspace file, written first, names no plugin.)
- vx runs and caches on this machine with no plugin, so the file declares no executor or cache.
- The file carries no comment: it is yours.
- A workspace with no scripts at all still gets the workspace file, a printed example config, and the next command to run.

</details>

**The members.** A root `package.json` with no `workspaces` field is single-project mode.

- When `packages/*/package.json` files sit below it unreached, the mapper says so. So does a run that finds no config.
- They say it rather than "no scripts" or "run vx init". The message ends `Add "workspaces": ["packages/*"] to package.json and re-run`.
- With no `package.json` or `pnpm-workspace.yaml` here or above, it stops and names `vx init`, which sets up a workspace without one.

<details><summary>Details</summary>

- The single-project message starts `package.json declares no workspaces …`.
- A workspace whose globs match no `package.json` gets a note naming them.
- A nameless member, or two sharing a name, is matched and named on its own line instead.
- So is a member directory whose name is not valid UTF-8, its bytes escaped, since no path names it.
- That line reads `packages/x\xff: the directory's name is not valid UTF-8, so its package.json cannot be read — rename it`.
- When such skipped scripts are all there is, the report's `tasks` row reads `none: no package.json script became a task`.
- It does not say there are none.
- `pnpm-workspace.yaml` may list the members while the root `package.json`'s `workspaces` lists other globs.
- Then the note names the unread list: pnpm reads only the yaml, while bun, npm and yarn read `package.json`.

</details>

**Types.** Every generated config is typed for the editor, with no runtime import.

```ts
import type { ProjectConfig } from '@vzn/vx/config'
```

- The config ends with `satisfies ProjectConfig`. The workspace file takes the same form (`satisfies WorkspaceConfig`).
- Bun erases a type-only import, so the file loads in a workspace that runs the `vx` binary without the package installed.
- A runtime `import { defineWorkspace } from '@vzn/vx'` costs nothing extra either.
- The running `vx` serves its own core to that specifier (bin.ts registers the alias).
- So a config or a plugin package never loads a second copy, and a workspace that runs the binary needs no `@vzn/vx` installed for it.
- The scaffold still writes the type-only form: it types the same with no import to resolve, in an editor without the package.
- A workspace that imports a plugin package at runtime without having installed it is told so, and to install its dependencies.

<details><summary>Details</summary>

- `--mjs` writes the same objects as `vx.config.mjs` and `.vx/workspace.mjs`, with no type import and no `satisfies`.
- Why: a package whose own `tsconfig` includes every `.ts` under it compiles a `vx.config.ts` into its dist (TanStack/query's `tsc --build`).
- An `.mjs` is outside that include.
- A file it writes that `.gitignore` drops gets a `note:` naming it and the `!vx.config.mjs` line that keeps it.
- Why: a commit would leave the file behind unnoticed. Example: vueuse ignores `packages/**/*.mjs`.
- When a whole directory is ignored, the note names that directory instead.
- Example: the old layout's `/.vx/` cache line now hides `.vx/workspace.ts` and the lock.
- Git re-includes nothing inside an ignored directory, so no `!` line helps. vx never edits `.gitignore`.
- A package with a `tsconfig.json` and no `"type": "module"` gets `vx.config.mts`.
- Why: tsc (node16, nodenext) reads a `.ts` there as CommonJS, and its type import of the ESM `@vzn/vx/config` fails (TS1479, TS1541).
- medusa's plugin builds failed that way. An output that takes the config back names the `.mts`.
- The written files then go through the repo's own formatter, when its root package.json declares one and it is installed.
- That is the first found of `prettier --write`, `biome format --write`, `oxfmt` or `dprint fmt`. A `note:` says so.
- Why: create-t3-turbo's `prettier --check` failed on the quotes of a written config.
- A formatter that fails leaves the files as written, and the note names its error.

</details>

**Scripts become tasks.** Each script becomes a task with its command verbatim.

- `build` gets `dependsOn: ['^build']` and **no `cache: true`**.
- A `build` that only delegates (`pnpm run compile`) is a group, and the edge goes on the script that does the work.
- A `TODO(vx-migrate)` shows the block to add, with the package's real inputs and outputs.
- The same block is the task's first line, commented: set the real globs and delete the `// `.
- `test` / `typecheck` wait for `build` when the package has one. `lint` reads sources and gets no edge.
- `dev` / `start` / `serve` / `watch` / `preview` become persistent tasks. A TODO asks for `readyWhen` when another task depends on one.

<details><summary>Details</summary>

- A task without `cache: true` always runs.
- A block with EMPTY outputs is not "uncached". It is a no-output task that hits on unchanged inputs, and skips the build with nothing to restore.
- So a deleted `dist` would stay deleted under a green `up-to-date` run.
- A guessed `dist/**` would restore the wrong tree for every package that writes elsewhere.
- The block the TODO shows names `dist/**`, or the default output of the framework the command runs:
  - `.next/**` minus `!.next/cache/**` for `next build`
  - `.output/**` for Nuxt
  - `build/**` for Remix, React Router, Create React App and Docusaurus
  - `public/**` for Gatsby
  - `storybook-static/**` for Storybook
- For any other command, it names the directory the command gives with `--outDir` / `--out-dir` / `-d`.
- Else it names the ones the command cleans first (`del-cli distribution`, `rimraf lib types`), unless it makes one again with `mkdir`.
- Else it names the outDir its `tsc` emits into, read from the tsconfig.
- Example: docusaurus's `lib/`, where `dist/**` restored only the buildinfo.
- A package in a cycle of builds gets, instead of `^build`, an edge to each build outside its cycle that `^build` would reach.
- It also gets a TODO to order the cycle, since `^build` there refuses the run.
- Example: nuxt's `@nuxt/nitro-server` devDepends on `nuxt`, which depends on it; pnpm sorts it away.
- A build whose `tsc -b` reaches a package its `package.json` does not name, through tsconfig `references`, gets a TODO to add it.
- Example: Effect's `@effect/ai-openrouter` referenced `../openai`.
- `^build` does not order that package's build first. So tsc builds it inside this task, writing its outputs beside its own build.
- And this task's key misses its edits.
- A Turbo build gets the same TODO, from `turbo()` and from the migration.
- A script may run a workspace package's bin that the package gets only through the root's dependencies.
- Example: vite's playgrounds run `vite` from the root's `vite: workspace:*`.
- Such a script also waits on that package's build (`vite#build`), since no `^build` edge reaches it.
- A watcher is a persistent task too. That is a `watch` segment in the script's name (`build:watch`), or a `--watch` flag.
- `--watch=false` and `--watchAll false` are no watchers. `tsc -w`, `rollup -w` and nodemon are.
- A server is a persistent task too: `serve <dir>`, `http-server`, or bare `vite`.
- `vite` with options before a `build` or `optimize` verb still exits (`vite --config x.js build`).
- So is a tool's `dev` / `serve` / `start` / `preview` verb (`next start`, `netlify dev`).
- So is a script that runs such a script of its package by name (`cross-env X=1 pnpm start`).
- So is one that runs it through a runner (`run-p web api`, `concurrently "npm:web" "npm:api"`).
- These count only outside quotes, and when not sent to the background with `&`.
- They are read past a launcher's `--package <name>` / `-p <name>` (`pnpm dlx --package netlify-cli netlify dev`).
- A script whose name no task may carry (`lint#fix`, `^up`; the schema's rule) is left out with a TODO.
- Written, it would make a config every later command refuses.
- So is a Turbo task, Nx target or Vite Task task of such a name, under `turbo()` and `nx()` as well as in the written configs.
- A `__proto__` script is written as a computed key, since a literal `__proto__:` sets the prototype.

</details>

**Existing configs.** Without `--force`, it never overwrites.

- A package that already has a vx config keeps it untouched, and the rest get theirs.
- The report lists the kept ones under `kept`, so a half-adopted workspace adopts the rest.
- An existing `.vx/workspace.*` in any extension the loader reads (`.mts` included) is kept.
- `--force` REPLACES a package's config of another extension (`replaced` in the report). Otherwise the loader would choose between two by its order.
- A Turbo, Nx or Vite Task migration still refuses an existing config.

**Hooks.** Two npm conventions are mapped rather than copied, because copying them loses behaviour.

- `pre<x>` / `post<x>` hooks, which npm runs around `x` without being named, are joined into `x`'s command, in that order.
- Each runs in its own subshell. So the chain stops at the first that fails, whatever a part holds (a `;`, an `exit`).
- Forwarded `--` args reach `x` alone, as npm hands them to the script and not its hooks.
- They are appended as text, so no part sees them as `$1`.
- The command is a small shell function, `vx_script`, around the three parts. It carries a TODO saying so.
- A `pre<x>` with no `x` stays a task of its own.
- The lifecycle scripts an install or a publish runs unasked are never tasks: `prepare` and its `pre` / `post` hooks, `dependencies`, `prepack`, `prepublishOnly`, pnpm's `pnpm:devPreinstall`, ….
- A script named for a verb joins its hooks too. Running the `version` script runs `preversion` in npm, pnpm, Yarn 1 and Bun.
- So the `version` task's command holds it.

<details><summary>Details</summary>

- Every project gets a `vx.config.ts`. A member with no script to run gets one declaring `tasks: {}`.
- That is a member with no scripts, or only lifecycle hooks (a types-only or config package), or none a Turbo or Nx repo runs.
- A project that already has a config keeps it.
- A package may have no `build` script, but a `prepack`, `prepublishOnly`, `prepublish` or `prepare` that runs a builder (`bob build`, `tsc`, `tsup`, …).
- The report names it, and says to add a `build` script running that builder.
- Example: react-navigation's twelve packages, whose root `build` is `lerna run prepack`, mapped with no build at all.
- Where the package's manager runs no such hooks, every `pre<x>` and `post<x>` is a task of its own.
- That is Yarn 2+: the nearest `packageManager: yarn@2+`, or a Berry `yarn.lock`.
- A `packageManager` naming none of npm, pnpm, yarn or bun defers to the lockfile.
- It is also npm under `ignore-scripts=true` in the `.npmrc` beside its lockfile.
- It is also pnpm under `enable-pre-post-scripts=false` there, or `enablePrePostScripts: false` in `pnpm-workspace.yaml`.
- Bun and Yarn 1 run hooks whatever those say.
- Under Yarn 2+, a segment's `run <script>` (Yarn's shell builtin) is written `yarn run <script>`, since vx's shell has no `run`.
- A Yarn 2+ repo on Plug'n'Play keeps its bins in `.pnp.cjs`, where vx's PATH finds none.
- That is one with no `nodeLinker: node-modules` or `pnpm` in `.yarnrc.yml`.
- The report says so, and names `nodeLinker: node-modules` or `yarn exec '<command>'`.

</details>

**npm variables.** A script reading `$npm_package_version`, `$npm_package_name` or `$npm_lifecycle_event` gets them under `exec.env.define`.

- Every manager sets them, and vx does not.
- The first two are read from an imported `package.json`, so a version bump reaches them.
- A field the manifest lacks stays unset, as npm leaves it.
- Any other `$npm_*` the script reads gets a TODO.
- A script that runs `wireit` gets `$npm_lifecycle_event` too: wireit reads the script's name from it (react-router's `"build": "wireit"`).
- That holds in Turbo repos too.

**Root scripts.** Among several packages, a workspace root script that runs the members is not mapped.

- Examples: `pnpm -r build`, `--filter`, `-C` (pnpm's `pn` alias included), Yarn's `--cwd` and `yarn workspace <name>`, npm's `--prefix`.
- Also npm's and Yarn's workspace flags, a `cd` into or above a member, turbo, nx, lerna, `vp run`, and vx itself.
- The rest check the whole workspace (`lint: oxlint .`, `test: vitest`). They become the root's own tasks, in a root vx.config.
- That needs a root `"name"` (vx skips a nameless root's config) and no root config of its own.
- A single-package repo's root is its project, and maps.

<details><summary>Details</summary>

- A flag counts on the package manager, or after `node <bin> run`, not on the program it runs.
- So berry's `yarn node -r ./setup.ts` is node's `--require`, and bun's `cd test && …` enters no member.
- Nor is a root script mapped that runs such a script by name. Example: vite's `ci-docs` is `pnpm build && pnpm docs-build`.
- That includes running it through `run-s` / `run-p` / `npm-run-all` or `concurrently "npm:x"` (lexical's `ci-check`).
- Nor is one whose name a member's task carries, so `--all` never runs a check twice.
- A root config already there, hand-written or from an earlier `vx init`, stays as written, `--force` included. It is listed under `kept`.
- The report names each script left out and why. A `pre` / `post` hook goes with its script.
- It gives examples of running the members, spelled by the repo's manager, and says which manager.
- Those are `--workspaces` under npm, and `yarn workspaces foreach` under Yarn 2+.
- With nothing mapped, it names the root whenever it has a script that is no lifecycle hook (`postinstall`, `prepare`).
- That holds whether the root is a member or not; pnpm's root is not.
- It says why: its scripts run the workspace, or share a member's task name (listed), or both.
- It tells a root with no `"name"` to add one first (vuejs/core), naming the scripts that would then map (react).
- It tells a root whose `"name"` a member also carries to rename it (insomnia).
- A root config would make the workspace refuse every run for the duplicate.
- A lone root beside a `lerna.json` (Lerna-classic: packages listed there, not in `workspaces`) gets a note naming the `workspaces` globs to add.
- With none listed there, those are Lerna's `packages/*` default.

</details>

**Members' scripts.** A member whose package.json has no `name` is no project.

- One with a script is named in the report, to be given a name (remix's `packages/component/bench`).
- A member's script that runs another member's work keeps its command, and gets a TODO naming that part.
- Examples: `pnpm -C ../pinia run build`, `yarn workspace <name>`, `-r` / `--filter`, npm's `-w`.
- Also a `cd`, `-C`, `--cwd` or `--prefix` into another member.
- The graph runs that member's task once. So name it under `dependsOn`, and drop it from the command (pinia).
- A directory inside the member or the root is no other member.

**Groups.** A script that only runs another script becomes a **group** over it: `dependsOn` and no command.

- So the graph runs and caches the target, instead of a package-manager subprocess it cannot see.
- The forms are `pnpm <other>`, `yarn <other>`, `bun run <other>`, and npm's `run <other>`, `test`, `start` and `stop`.
- Aliases count too: npm's `run-script`, `rum`, `urn`, `t` and `tst`, and pnpm's `run-script`, `t` and `tst`.
- When `build` is such a group, the task it reaches that runs a command takes `^build` and the cache TODO. A group has nothing to cache.
- That task and the groups on the way drop the wait on `build` a `typecheck` or `test` would carry, since they are the build.

<details><summary>Details</summary>

- Bare, a package manager's own command is not a script. Each stays a command.
- Examples: `bun test` is Bun's test runner, `bun build` its bundler, `pnpm install` and `yarn add` the managers' verbs.
- So do the names each manager reserves or hands on: `pnpm docs` and `pnpm version` (npm's), `bun deploy`, `yarn check`.
- `pnpm test`, `yarn test` and `bun lint` do run the script.
- Arguments, flags or a `&&` chain make it a real command again, and it is left verbatim.
- So is one whose target becomes no task (a lifecycle script, or a hook joined into another script).
- A group over it would name a task nothing defines.
- A verbatim chain whose parts run this package's own scripts gets a TODO naming those parts.
- Example: `check: pnpm run build && pnpm run lint`. Each part runs again inside the command, beside its own task, so `vx run check` builds twice.
- So does a part that runs them through `run-s`, `run-p` or `npm-run-all` (`build: run-p build:*`), unless the task is persistent.
- Its order may matter, so it is not made a group.

</details>

**The report.** The report lists each TODO once per reason.

- Tasks that share one are named together: the first five, then a count. The files carry each.
- When no task caches, it says uncommenting a TODO task's cache line makes the second run a hit.
- Its `next:` line is a command you can type, with a bare `vx` (`vx init` installs it).
- Outside a git work tree it starts with `git init`. With no script mapped, it starts with declaring a task.
- The run would refuse without either.
- It runs `build`, else the first task that neither serves (`persistent`) nor changes the repo, else the first task.
- Tasks that change the repo include `clean`, `release`, `publish`, `deploy`, `version`, `format` and `fix`.

### Errors reading the members

The root a migration starts from, and its members, are the package manager's (`src/packages.ts`).

The root is the nearest `pnpm-workspace.yaml`, or `package.json` with `workspaces`, that lists the directory it runs in. What it refuses:

| Symptom                                                                                                      | Cause                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to parse <file>: <why>`                                                                              | A `package.json` / `pnpm-workspace.yaml` is not valid.                                                                                                                                                                                         |
| `<file>: packages must be an array of glob strings`                                                          | `pnpm-workspace.yaml` `packages:` is a bare string, etc.                                                                                                                                                                                       |
| `<file>: must be a JSON object`                                                                              | A `package.json` (the root's or a member's) is `null`, a list or a scalar.                                                                                                                                                                     |
| `<file>: "name" must be a string with no surrounding whitespace`                                             | A `package.json` `name` is a number, an object, or has surrounding whitespace (npm refuses one too).                                                                                                                                           |
| `<file>: "name" cannot hold "#" — vx addresses a task as <name>#<task>`                                      | A `package.json` `name` holds `#` (npm refuses one too): `{"name":"a#b"}` would plan `a#b#build` under `--all`, but `vx run a#b#build` and a `dependsOn` split at the first `#` and find nothing.                                              |
| `<file>: must be a mapping (packages: and pnpm's settings)`                                                  | `pnpm-workspace.yaml` is a list or a scalar. A mapping with no `packages:`, or an empty one (pnpm 10 settings or catalogs in a single-package repo) is not an error: the root's `package.json` decides, as without the file.                   |
| `<file>: workspaces must be an array of glob strings`                                                        | `package.json` `workspaces` holds a non-string entry.                                                                                                                                                                                          |
| `workspace member <dir> (<abs>) is outside the workspace root <root>: vx keeps every project under the root` | A member glob (`../ext/*`, an absolute path) reached a package outside the root. npm and pnpm take one; `--affected` asks git from the root and would miss edits there. Move the root up to a directory that holds every member.               |
| `<file>: workspaces.packages must be an array of glob strings`                                               | The yarn-legacy `workspaces: { packages: [...] }` form holds a non-string entry.                                                                                                                                                               |
| `<file>: <field> entry "<glob>" is an extglob, which vx's glob engine does not read`                         | A member glob holds `!(…)`, `@(…)`, `+(…)`, `*(…)` or `?(…)`. `Bun.Glob` has no extglob (its scan would widen `packages/!(x)` to include x); a whole-segment `!(a\|b)` gets its exact rewrite, `["packages/*", "!packages/a", "!packages/b"]`. |

A member whose directory is a link out of the root (`packages/a -> ../../out/a`) is refused when the configs are written, before any is written.

The message reads `packages/a/vx.config.ts: outside the workspace root (packages/a resolves to <real>); vx loads no project there`.

Core's discovery never loads a config there. A link to a directory inside the root is written at its real place.

## `turboCache()` — a Turbo remote cache

`turboCache()` stores vx artifacts in any server speaking Turbo's `/v8/artifacts` API.

That is Vercel's hosted cache, or a self-hosted implementation of the published OpenAPI spec (Bearer auth, `x-artifact-duration`, HMAC-SHA256 `x-artifact-tag` signatures).

The wire is theirs; the bytes are vx's own artifacts under vx's own keys.

The server is storage: the other tool cannot read what vx stores there, and vx does not read its entries.

Nothing is on by default. Declare the plugin in `.vx/workspace.ts`, and configure it explicitly.

Reads try the local cache first, and the remote only on a local miss:

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

Off CI a run reads the remote, and does not write it unless its policy names the remote.

Give the write token only to the default branch's CI, and a read-only one to laptops and pull request jobs.

The server's token is the boundary (`docs/security.md` § Cache poisoning). The same holds for `nxCache()`.

**Where options come from.** Every option falls back to the tool's own environment variable, so a self-hosted setup carries over unchanged.

- An empty variable is unset, as Turbo reads it.
- With no URL the cache is Vercel's hosted Remote Cache (`https://vercel.com/api`), as for `turbo`.
- So `bunx turbo login && bunx turbo link`, then `turboCache()` with `TURBO_TOKEN` / `TURBO_TEAM` set, is the whole hosted setup.
- A `url`, `token` or `oidc` option names a cache, with or without a team.
- A team with no token takes the token from the OS keychain ([Tokens](#tokens-and-the-os-keychain)).

<details><summary>Details</summary>

Below the environment, in Turbo's order, the plugin reads:

- A Vercel build's `VERCEL_ARTIFACTS_TOKEN` and `VERCEL_ARTIFACTS_OWNER` (the team id), where `TURBO_TOKEN` with a team is not set.
- Then the repo's `.turbo/config.json`, which `turbo link` writes: `apiUrl`, `teamId`, `teamSlug`, `token`.
- A `.turbo/config.json` that is not a JSON object is named in a warning and read as absent, where Turbo refuses it.
- Then the root `turbo.json`'s `remoteCache` (`apiUrl`, `teamId`, `teamSlug`).
- Its `enabled: false` declines, unless the options name a cache.
- As for `turbo`, these sources link a cache only with a team. A token without one is named in a warning.
- With no team, the plugin **declines** and the run stays local.

</details>

| Option            | Environment variable                                                                                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `TURBO_API`                                                                                                       | base URL of the cache server; default with a token: `https://vercel.com/api`; http(s) only (http to any host, as Turbo and Nx take it), with no blanks around it; a `user:pass@` in it is refused, the option's when the config loads                                                                                                                                                    |
| `token`           | `TURBO_TOKEN`                                                                                                     | Bearer token on every request; then OIDC, `.turbo/config.json`, the OS keychain                                                                                                                                                                                                                                                                                                          |
| `oidc`            | `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` (GitHub sets them)                               | `true` or `{ tokenUrl, revokeUrl, audience, params }` (`TurboOidcOptions`): exchange the GitHub Actions job's OIDC token for a short-lived one ([OIDC](#oidc-on-github-actions))                                                                                                                                                                                                         |
| `teamId`          | `TURBO_TEAMID`                                                                                                    | `teamId` query parameter (Vercel's `team_` form only, as Turbo sends it); part of the signature                                                                                                                                                                                                                                                                                          |
| `teamSlug`        | `TURBO_TEAM`                                                                                                      | `slug` query parameter                                                                                                                                                                                                                                                                                                                                                                   |
| `signatureKey`    | `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, read only under turbo.json's `remoteCache.signature: true`, as Turbo reads it | HMAC-SHA256 key, used raw, over the team id (`''` without one, as in Turbo); the option needs ≥ 32 bytes, the env key warns below that unless `futureFlags.longerSignatureKey` refuses it; signing on with no key turns the remote off with a warning; a download whose tag does not verify is a miss                                                                                    |
| `timeoutMs`       | `TURBO_REMOTE_CACHE_TIMEOUT`, then `remoteCache.timeout` (seconds)                                                | HEAD/GET/POST deadline (default 30 s; 0 none); the option is ms up to 2³¹−1 (the longest a timer holds), the variable and file are held to it                                                                                                                                                                                                                                            |
| `uploadTimeoutMs` | `TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT`, then `remoteCache.uploadTimeout` (seconds)                                   | PUT deadline (default 60 s; 0 none), bounded as `timeoutMs`                                                                                                                                                                                                                                                                                                                              |
| `retries`         | —                                                                                                                 | resends of a request answered 5xx (not 501) or never connected (default 1, Turbo's); a 429 waits out the limit; 0 turns both off                                                                                                                                                                                                                                                         |
| `preflight`       | `TURBO_PREFLIGHT` (1 or 0), then `remoteCache.preflight`                                                          | send Turbo's `OPTIONS` preflight before each artifact request and go where its `Location` points (relative to the URL); the token goes along only when the API's `Access-Control-Allow-Headers` admits `Authorization`; a redirected preflight is not followed; a `Location` that is not http(s), or plain http the token would go to from an https URL, fails the request (default off) |
| `scope`           | —                                                                                                                 | `RemoteScope`: `'header'` (default): every read names the run's refs, own branch first, in `x-artifact-read-scopes`; `'key'`: each entry is keyed on its ref, a read asks every ref's key in one batch (a server that ignores the header)                                                                                                                                                |

**Signatures.** The signature is Turbo's current scheme, `artifact-signature:v2`.

- Prefix, hash, team id and body are each length-prefixed, under HMAC-SHA256, and sent base64 in `x-artifact-tag`.
- A signed body is copied to a temp file as it passes, for its tag to be checked at the end.
- So one past core's artifact ceiling (2 GiB, at zstd's bound) is refused as it passes it, and is a miss.
- A download with no `x-artifact-tag` is a miss that says so. turborepo-remote-cache keeps the tag only with its own `TURBO_REMOTE_CACHE_SIGNATURE_KEY` set; without it, every signed read misses.

**Streaming.** Artifacts stream both ways on both wires.

- An upload sends the local artifact from its file. A download hands vx the response body, to write straight to disk.
- A signed download streams to vx as it arrives, and is copied to a temp file in vx's cache directory as it passes.
- The sandbox walls that directory, unlike the shared temp dir a sandboxed task may read.
- The tag covers the body's length, which a chunked response does not declare up front, so it is checked from the temp once the last byte is in.
- A bad tag errors that last read. vx stages a download in its own temp and keeps it only once the last read succeeds.
- So a body that fails its tag (tampered, truncated, or under a wrong tag) leaves no cache entry and restores no output file: the task runs as a miss.
- The temp goes once the body is read or cancelled.
- A process that exits first deletes it on the way out (vx's Ctrl-C exit awaits no stream).

## `nxCache()` — an Nx self-hosted remote cache

`nxCache()` stores vx artifacts in any server implementing Nx's remote cache OpenAPI spec.

That spec is `GET`/`PUT /v1/cache/{hash}`, Bearer auth, and immutable records. A second write of a hash is `409`, which the plugin treats as done.

Same rule: the wire is theirs, the bytes are vx's.

A download asks for `Accept: application/octet-stream`, as Nx's own client does. `turboCache()` asks the same way.

Why: an API gateway that keys binary media on `Accept` base64-encodes anything else.

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { nxCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [nxCache({ url: 'https://cache.example.com', token: process.env.CACHE_TOKEN })],
})
```

Every option falls back to the tool's own environment variable. A missing token falls back to the OS keychain ([Tokens](#tokens-and-the-os-keychain)).

With no server, the plugin **declines** and the run stays local.

| Option      | Environment variable                       | Meaning                                                                                                                                                                               |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`       | `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`       | base URL of the cache server; http(s) only (http to any host, as Turbo and Nx take it), with no blanks around it; a `user:pass@` in it is refused, the option's when the config loads |
| `token`     | `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | Bearer token, else the OS keychain; `''` (option or variable): an open server                                                                                                         |
| `timeoutMs` | —                                          | per-request deadline (default 30 s; ms above 0, up to 2³¹−1)                                                                                                                          |
| `retries`   | —                                          | resends, as `turboCache()`'s (default 1)                                                                                                                                              |

The Nx spec has no existence probe. So `has` (the `--dry` prediction; the prefetch pass calls `get`) is a `GET` whose body is cancelled before it answers.

The wire carries no producing-task duration, so a remote hit reports none.

## OIDC on GitHub Actions

`turboCache({ oidc: true })` needs no `TURBO_TOKEN` secret on GitHub Actions. Give the job this permission:

```yaml
permissions:
  id-token: write
```

- Before the first task, when the run's policy uses the remote, it asks GitHub for the job's OIDC token.
- That uses `ACTIONS_ID_TOKEN_REQUEST_URL`, with `audience` when given.
- It exchanges the token at the token endpoint (RFC 8693) for a short-lived cache token, and revokes that (RFC 7009) when the run ends.
- With Vercel's hosted cache, the defaults are Vercel's endpoints, its OAuth client id, and `team_id_or_slug`, as Vercel's own action sends them.
- `team_id_or_slug` is the team id, else the slug; one is required. `params` adds fields such as `policy_id`.
- Any other server names its `tokenUrl` (and `revokeUrl`, or none). `params` carries its extras.
- `revokeUrl: false` skips the revoke.
- A wrong `oidc` shape (not `true`, a field it does not take, a non-string value) is refused when `vx lock` loads the workspace.
- Order: the `token` option, `TURBO_TOKEN`, then OIDC, then `.turbo/config.json`, then the OS keychain.
- A request is tried three times on a `429`, a `5xx` or no answer, 30 s each.
- A failed exchange is one warning and a local-only run.
- A failed revoke is a warning; the token expires on its own.
- No message quotes a token.
- A job without `id-token: write` gets no OIDC variables: one warning, and the sources below OIDC answer.
- A pull request from a fork, and a Dependabot one, never gets an OIDC token.
- `nxCache()` has no OIDC: Nx's cache spec names no exchange.

## Tokens and the OS keychain

With no token from an option, a variable or a config file, both plugins read the OS keychain through core's `ctx.secret`.

- That is `Bun.secrets`: macOS Keychain, libsecret on Linux, and the system credential manager elsewhere.
- The service is `@vzn/vx-migrate`. The entry is named by the endpoint and team, so separate caches never share a token.
- For `turboCache()`: `https://remote.cachely.dev/v8/artifacts#cachely` (team id, else slug; no `#…` without a team).
- For `nxCache()`: `https://cache.example.com/v1/cache`.
- The keychain is read once per run, only by a run that uses the remote: before its first task, when its policy reads or writes the remote.
- `--no-cache`, `--cache-policy=remote:`, `--dry`, `vx show` and `vx info` never touch the keychain.
- Off CI, remote writes are already off by default ([`cli.md` § Cache control](../vx/docs/cli.md#cache-control---cache-policy---no-cache---force)).
- Missing, on a terminal (stdin and stderr TTYs, `CI` unset), the token is asked for once, with input hidden, and saved.
- The prompt reads `Token for remote.cachely.dev (cachely), saved to the OS keychain: `. Later runs read it without asking.
- Missing anywhere else (CI, piped), or with an empty answer, the run warns once and goes on with the local cache. Ctrl-C stops the run.
- The warning names the remote and the fixes. Set `TURBO_TOKEN` / `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, or run in a terminal.
- Or pass `--cache-policy=remote:` to skip the remote.
- A keychain token the server refuses (`401` / `403`) is deleted, with the warning, so the next run asks again.
- A host the token never reached cannot refuse it: one past a cross-origin redirect, or a preflight `Location` that did not admit it.
- Such a host's `403` fails that one request.
- A token from an option or a variable is never deleted.
- No keychain (headless Linux without libsecret) reads as empty. It never breaks a run.
- The token never reaches a task: the task environment does not pass `TURBO_TOKEN`, `VERCEL_ARTIFACTS_TOKEN` or Nx's variable.

## Remote-cache behaviour (both)

A remote error never fails a run: it degrades to a miss and a warning.

```text
[vx] plugin '@vzn/vx-migrate': upload 32248a2a7c89e241 to https://cache.example.com/v8/artifacts failed: no answer within 60000 ms
```

- The warning names the request, the artifact and the server. It never quotes the token.
- A token a server's refusal quotes is written `***`: the option's, the keychain's, an OIDC exchange's, GitHub's, or a lent one.
- Task keys carry no branch. `turboCache()` names the run's refs on every read (`HEAD`, `GET`, the batch `POST`) in `x-artifact-read-scopes`.
- Its own branch comes first: `refs/heads/feat-x, refs/heads/main`.
- A ref past ASCII is percent-encoded as UTF-8: `refs/heads/%C3%BCber`.
- The refs come from CI's env, else git's current branch, then the default branch.
- A `PUT` names none. Where a write lands is the server's call, from the CI OIDC token checked against its trust policy.
- `scope: 'key'` hashes the ref into each key instead, for a server that ignores the header.
- `nxCache()` sends plain requests.
- The batch `POST` carries at most 100 hashes, Vercel's limit. More go in parallel batches.
- A batch refused with any status but 404, 405 or 501 (no batch query) is reported with its body. So is a 200 answer that is no JSON object.
- How a server implements the header: [Branch caches a server enforces](https://vznjs.github.io/vx/blog/branch-caches-a-server-enforces/).
- A hit that does not restore (bad bytes, a signature that does not verify) re-runs the task.
- vx keeps a download only once it reads back whole and checks out, so a bad one, altered or cut short, restores no output file and leaves no cache entry.
- `turboCache()` then uploads its save over the stored entry, skipping the `HEAD` it asks before other uploads.
- It does so also when another machine of the run (a `@vzn/vx-dte` worker) read the bad copy.
- Nx's records are immutable (`409`), so `nxCache()` cannot repair one. That `put` returns `false`, so the run does not count the copy fixed.

<details><summary>Details</summary>

- The same failure is said once per run. An unreachable server fails the probe, the download and the upload alike.
- The run prints the first, and at its end a count of the rest. Core does the counting, for every cache plugin.

```text
[vx] plugin '@vzn/vx-migrate': 2 more requests failed the same way: Unable to connect. Is the computer able to access the url?
```

- A request answered `5xx` (not `501`), or one that never connected (a refused port, an unresolved host), is sent again after 2 s, `retries` times.
- A `429` pauses every request to that remote for its `Retry-After`, capped at 10 s a wait (2 s without one).
- The request is sent again when the pause ends, for up to 20 s from its first `429`, as Turbo's client does.
- A spent deadline is not resent: it has already cost its wait.
- Three outages in a row open Turbo's outage breaker: no connection, no answer within the deadline, or a `5xx` once the resends are spent.
- While it is open, no request is sent for 30 s, and each lookup is a miss at once. Then one request probes, and its answer closes or reopens it.
- A hit is judged when its body ends, so a server that sends headers and then stalls the body counts the same way.
- A hung server costs three deadlines, not one per task.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process.
- Requests already in flight when the refusal lands degrade in silence, rather than repeating it.
- A `403` on an upload is a read-only token (Nx's spec, or turborepo-remote-cache's `READ_ONLY` and write-less JWTs).
- It turns off uploads alone, and reads go on.
- Only a host the token went to can refuse it. A storage URL's `401`/`403` (an expired signature) fails that request alone.

</details>

**Policy.** Core's policy alone decides reads and writes.

- Policy (`--cache-policy=remote:r`, `VX_CACHE_POLICY`, `cache.policy`) is enforced by core, which layers each plugin's remote over the local cache.
- A read-only token pairs naturally with `remote:r`.
- The plugins read none of Turbo's or Nx's own switches.
- Those are `TURBO_CACHE`, `TURBO_REMOTE_ONLY`, `TURBO_REMOTE_CACHE_READ_ONLY`, `NX_SKIP_REMOTE_CACHE` and `NX_DISABLE_REMOTE_CACHE`.
- `turbo()` reads `TURBO_FORCE`, as `--force`.
- A CI that keeps untrusted pull requests off the shared cache sets `cache.policy` or `--cache-policy=local:rw,remote:r` for them.

## Testing

`bun test` runs the Turbo and Nx plugins over fixture workspaces.

- The Nx one runs against a fake `nx` whose graph export and `runExecutor` are stubs. So the vx → `nx-exec` → executor → cache round trip is real.
- It runs the migrate CLI over both sources.
- It runs each remote-cache wire against a strict in-memory implementation of its spec.
- It adds a full `vx run` round trip: miss → upload → local wipe → restore from the server.
- A separate suite points both plugins at a HOSTILE server, and pins that each one degrades to a miss with the run still green.
- That server answers 500 on every request, or 401, or never answers, or sends a body that is not an artifact.
- `tests/nx-exec-live.test.ts` runs `nx-exec` against REAL Nx when `VX_NX_MODULES` names a directory whose `node_modules` holds `nx`, `@nx/js` and `typescript`.
- CI installs one under `packages/vx-migrate/.nx-live` and sets `VX_REQUIRE_NX=1`, so an absent install fails there instead of skipping.
