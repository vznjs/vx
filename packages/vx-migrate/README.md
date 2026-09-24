# @vzn/vx-migrate

Everything for adopting [`@vzn/vx`](https://github.com/vznjs/vx) from Turborepo or Nx, in one package with zero dependencies:

- **`turbo()`** — run a Turbo repository under vx with nothing written. The plugin fills vx's `project` stage from `turbo.json` and each package's `package.json` scripts. A trial that commits nothing.
- **`nx()`** — run an Nx repository under vx with nothing written: the same stage, filled from Nx's resolved project graph. Executor targets (`@nx/js:tsc`, `@nx/vite:build`, your own) run as themselves through **`nx-exec`**, one executor per process.
- **`bunx @vzn/vx-migrate`** — write one `vx.config.ts` per workspace package from your `turbo.json` or an exported Nx project graph, plus the workspace file every run needs. Runs without a workspace file, so it is the first command, not the second.
- **`turboCache()`** and **`nxCache()`** — keep the remote cache you have: any server speaking Turbo's `/v8/artifacts` API (Vercel's hosted cache included) or Nx's self-hosted `/v1/cache` spec.

```ts
// vx.workspace.ts — a Turbo repo, unchanged, with its remote cache
import { defineWorkspace } from '@vzn/vx'
import { turbo, turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turboCache(), turbo()] })
```

## `turbo()` — run a Turbo repo unchanged

Then `vx run build --all` runs every package's `build` script the way `turbo run build` would: `dependsOn` edges (`^build`, same-package deps, `pkg#task`), `inputs` / `outputs` as the cache block, `env` / `passThroughEnv`, `cache: false`, `persistent`. Turbo's global fields (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`) are inlined into every task; per-package `turbo.json` overlays apply. What runs is what a migration would have written, minus the file: the key a task derives here equals the key the written config would derive.

| Option | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| `root` | Directory holding `turbo.json`. Defaults to the workspace root. |

### Locking

`vx lock` freezes the evaluation of written `vx.config.*` files only. A package that has none gets its tasks from `turbo.json` on every load — under `--frozen` too — so the lock records nothing for it and `vx lock --check` does not audit it; `turbo.json` is its source of truth, committed like one.

### What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from `turbo.json`.
- The mapping's gaps are the migration's gaps, reported as warnings on every run instead of `TODO(vx-migrate)` comments: `$TURBO_ROOT$` tasks, wildcard env names, negated outputs, unknown turbo keys. A persistent task's readiness note (`readyWhen`) is reported only when something depends on it — with no dependent there is nothing to gate (refine printed it for 375 `dev` targets a run). `bunx @vzn/vx-migrate --dry` lists the same set once. Each gap is one line per run for every task that carries it, not one per task (n8n marks `dev` and `watch` persistent in most of its 84 packages; astro negates `vendor/**` in the outputs of 57 tasks). A per-package `{ "extends": false }` with nothing else is Turbo's opt-out and maps to no task; with keys, the task runs on those keys alone. A glob that climbs out of the package (`../../packages/app-store/*.generated.ts`) is re-anchored on the workspace root as a `workspaceFiles` glob. A negated output under a literal-rooted one (`dist/**` minus `!dist/**/*.map`) is a todo and the positive glob stays; one against a wildcard-rooted output (medusa's `*/**` minus `!src/**`) makes the task uncached, because the clean before exec would otherwise delete the sources — declare the exact outputs in a vx.config to cache it.
- The cost is the stage's: on a 1,000-package workspace with no `vx.config` files the mapping loads in about 42 ms where 1,000 evaluated configs load in 22, in a run that is otherwise the same ~200 ms warm.
- The mapping is read once per run, never once per process: under `vx watch`, a `package.json` script edit or a per-package `turbo.json` overlay edit is the next cycle's tasks. The root `turbo.json` is no task's input and lives in no project dir, so an edit to it is not a cycle — restart the watch.

### The mapper (`mapTurboWorkspace`)

The plugin and the CLI read a repo the same way: the mapper the plugin runs live is what `bunx @vzn/vx-migrate` writes `vx.config.ts` per package from, splicing Turbo's global fields in as imports of a generated `vx-preset.ts`, where the plugin inlines the values. `splice` is the seam between the two consumers; `uses` names which globals a task drew on. Before 2026-09-10 the mapper lived in `@vzn/vx` itself; until 2026-09-11 the plugin was its own package, `@vzn/vx-turbo`.

Rules:

- **A task exists for a package only when the package declares the script** — Turbo's own rule. An absent script is silent; a script key whose value cannot be a command (a number, `null`, an empty string, an array) produces a `task: null` entry whose todo says why, rather than a config that fails to load.
- **Definition order**: root `name`, then root `pkg#name`, then the package's own `turbo.json` — later overlays win field by field.
- **The command is the script body** with its `pre<name>` / `post<name>` hooks folded in, in that order (npm and pnpm run them around `<name>` without being asked; novu's `prebuild` copies the CSS its `build` inlines), one process less per task than `pnpm run <name>` — except a body that calls yarn's `run` builtin (`run -T rollup -c`, `run clean && run build`; yarn ≥ 2 runs scripts in its own shell), which is `run: command not found` in sh: it runs as `yarn run <name>`, as Turbo and Nx run it, and yarn ≥ 2 runs no hooks, so none are folded there. Same rules for `nx:run-script` below (strapi and novu, 2026-09-11).
- `dependsOn`: `^x` passes through when some package runs `x`, and is dropped when none does (Turbo gives it no edges; core refuses a `^x` no project declares as a typo); `pkg#task` is kept only when `pkg` emits `task` (else a todo: edge dropped); a same-package name the package lacks simply has no edge; `$TURBO_ROOT$` deps are a todo (vx has no workspace-root tasks, and root `//#` tasks become a note).
- `inputs`: absent → `**/*` (Turbo's default); `$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/<path>` → `cache.inputs.workspaceFiles` (negation kept); any other `$TURBO_ROOT$` use is a todo. `globalDependencies` land in `workspaceFiles` too.
- `outputs`: `$TURBO_ROOT$/<path>` → `cache.outputs.workspaceFiles`; a negated output is a todo (vx outputs have no negation).
- `env` / `passThroughEnv`: explicit names go to `cache.inputs.env` (env only) and `exec.env.passThrough` (both, plus both globals); a wildcard is a todo. A name both a global list and the task's own list carry is listed once.
- **Two tasks of one package on one output path** (strapi's `build`, `build:code` and `build:types`, all on `dist/**`): vx cleans a task's outputs before it runs and before a restore, so the loader refuses two cached tasks whose outputs provably overlap. The mapping resolves it before the file is written — the task with a `^` edge keeps its cache (the first declared when none has one); a task a same-project edge orders after it stays cached too (vx caches what an ordered dependant ADDS to the tree — twenty's `build:individual` into `build`'s `dist`); the rest run uncached with a todo naming the keeper and the fix, their own output path or that edge. Same rule for Nx targets.
- `cache: false` or `persistent: true` → no `cache` block; a persistent task gets `exec.persistent: {}` and, when some task depends on it, the consumer's `persistentTodo`.
- `outputLogs: "new-only"` maps to nothing: frames for the tasks that ran and a one-liner per cache hit is vx's default flow already. The other values are per-run in vx, so they are a todo naming the flag (`vx run … --output-logs hash-only`).
- An unknown Turbo key is a todo naming it; `extends` is accepted and ignored (the overlay order above is what it means).

## `nx()` — run an Nx repo unchanged

```ts
// vx.workspace.ts — an Nx repo, unchanged
import { defineWorkspace } from '@vzn/vx'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
```

Then `vx run build --all` runs every project's `build` target the way `nx run-many -t build` would. The plugin reads Nx's **resolved** project graph — where Nx has already applied `targetDefaults`, expanded `namedInputs`, inferred targets through its plugins and interpolated `{projectRoot}` and friends — so nothing is re-derived here. Per target: `nx:run-commands` and a plain `command` run as one shell line that does what Nx's run-commands does (below); `nx:run-script` is the package script; `nx:noop` is a group task; **every other executor runs through `nx-exec`** with the executor and its options on the command line. A target Nx caches (`cache: true`, or the legacy `cacheableOperations` list in `nx.json`) gets its `inputs` / `outputs` as the cache block, with no `inputs` meaning Nx's `default` named input and an output outside the project dir (`dist/<project>` at the workspace root, Nx's default layout) a `workspaceFiles` output; `dependsOn` becomes the edges (`^build` — dropped when no project has the target, as Nx gives it no edges and core refuses a `^name` nothing declares — `build`, `project:target` → `project#target`, `project:target:configuration` → that configuration's task), `{ env }` inputs pass through, a target that says `continuous` — or, in a graph from an Nx older than that field, runs a server executor (`@nx/vite:dev-server`, `@nx/next:server`, …) — is a persistent task and never cached, with the `readyWhen` note only when something depends on it. The target's name never decides: a cached `dev` caches like any other target (nx#32610). A target with `configurations` is one task per configuration: `build` carries the default configuration's options, `build:ci` the `ci` one.

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

### The graph snapshot

Once per run the plugin compares its snapshot (`<cache dir>/nx-project-graph.json`) against `nx.json` and every discovered package's `project.json` and `package.json` by mtime. A newer input, or no snapshot, runs `node_modules/.bin/nx graph --file=<snapshot>` — the one time Nx itself runs, served from the daemon when one is up — and a fresh snapshot costs the stats alone (a few milliseconds at a thousand packages). A target an Nx plugin infers from a file this rule does not stat (a `vite.config.ts` edit that changes an inferred target) is picked up by the next Nx command you run, or by `nx graph --file`; an export that fails with a snapshot in hand warns and runs on the previous graph. The snapshot is machine-local, like the cache: nothing about it enters a key. Measured at 1,000 projects: the export runs once (1.7 s with the daemon off, Nx's own computation), and after it the stats and the mapping add about 30 ms to a run that is otherwise the same ~250 ms warm (2026-09-23, after items 608 and 609: the stage reads 51–59 ms against ~24 for evaluated configs). Under `vx watch` the same rule runs per cycle: a `project.json` edit is the next cycle's tasks, the export included — 1.3 s from the edit to the new command's effect on that workspace.

### What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from the graph.
- Targets of an Nx project no workspace package matches — the root project, usually — have nowhere to go and are reported once per run; run them with `nx`, or declare them in a `vx.config`.
- Nx adds an `nx-release-publish` target (`@nx/js:release-publish`) to every project with a `package.json`; it comes along as one `nx-exec` task per package, run only when asked (`vx run nx-release-publish --filter <pkg>`), and counts in `vx info`'s task total.
- `nx-exec` and `nx-env` must be on every task's PATH, which they are when `@vzn/vx-migrate` is a devDependency of the workspace (its bins land in `node_modules/.bin`); a plugin loaded by path warns once per run when they are not. Both load Nx from the workspace, so a repo run from an exported `graph` with no `node_modules/nx` warns once too.
- Nx's configuration propagation (`nx run app:build:production` builds dependencies with `production` where they declare it): a `build:production` task's `^build` edges run the dependencies' default configuration, with a warning naming it.
- Batch executors run one task per process; an executor that reads `context.taskGraph` under `NX_BUILDABLE_LIBRARIES_TASK_GRAPH` sees none and takes Nx's project-graph path.
- The mapping's gaps are the migration's gaps, reported as warnings once per run for all the tasks that carry each one. `bunx @vzn/vx-migrate --dry --from nx` lists the same set once.

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
bunx @vzn/vx-migrate           # auto-detect: turbo.json, or .nx/workspace-data/project-graph.json
bunx @vzn/vx-migrate --dry     # print the generated files + the report instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
```

`--dry` prints the files instead of writing them; `--force` overwrites existing ones; `--mjs` writes `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts` — the same objects with no type import and no `satisfies`, for a package whose own `tsconfig` includes every `.ts` under it and would compile the config into its dist (TanStack/query, 2026-09-11).

`package.json` scripts are core's own `vx init`. What this package writes reads exactly like what `vx init` writes: both hand a plan to core's migration seam (`applyMigration` from `@vzn/vx`), which renders, refuses to overwrite without `--force`, writes and reports. Anything a source cannot say becomes a `TODO(vx-migrate)` comment, never a silent wrong value.

### Turbo

Reads the root pipeline (`tasks` in Turbo 2, `pipeline` in Turbo 1), per-package `turbo.json` `extends` overlays and each package's scripts, through the same mapper `turbo()` runs live — so a repo reads the same whether you migrate it or run it as it is. Turbo's global fields become a generated root `vx-preset.ts` each config imports and spreads: TypeScript composition replaces global config.

| Turborepo                           | vx                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `dependsOn`                         | `dependsOn`, same micro-syntax (`$TURBO_ROOT$` deps are a TODO)                        |
| `inputs`                            | `cache.inputs.files` (`$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/x` → `workspaceFiles`) |
| `outputs`                           | `cache.outputs.files` (a negated output is a TODO)                                     |
| `env`                               | `cache.inputs.env` **and** `exec.env.passThrough` (child envs are isolated)            |
| `passThroughEnv`                    | `exec.env.passThrough`                                                                 |
| `cache: false` / `persistent: true` | no `cache` block; `exec.persistent: {}` with a TODO to set `readyWhen`                 |

### Nx

Reads the **resolved** project graph only (`.nx/workspace-data/project-graph.json`; export one with `nx graph --file=.nx/workspace-data/project-graph.json`), through the same mapper `nx()` runs live — so a repo reads the same whether you migrate it or run it as it is. Targets Nx plugins infer at runtime are frozen as the snapshot saw them. `nx:run-commands` is the one shell line `nx()` runs (see [`nx:run-commands`](#nxrun-commands) above: where, parallel or in order, forwarded arguments, `env`, `readyWhen`) — storybook's `compile` is `cd ../../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli`; a plain `command` is that shorthand; `nx:run-script` is the package's script body with its `pre<name>` / `post<name>` hooks folded in (or `yarn run <name>` when the body calls yarn's `run` builtin; an empty script is the placeholder with a todo), `nx:noop` is a group task; **every other executor is an `nx-exec` line** carrying the executor and its resolved options, no TODO — keep `nx` and `@vzn/vx-migrate` installed for as long as a config runs one, and replace the line with the bare command (`vite build`, `tsc -p …`) when the target leaves Nx. A target with `configurations` writes one task per configuration (`build`, `build:ci`). Named inputs expand from `nx.json` when readable. An output naming a bare directory (`{projectRoot}/dist`, `{projectRoot}/.output`) becomes its subtree glob (`dist/**`, `.output/**`); a name with an extension past its first character (`coverage/lcov.info`) stays a file. The graph's dependency edges are ignored — vx derives package edges from `package.json` — except for one report line counting edges with no manifest counterpart.

## `turboCache()` — a Turbo remote cache

Store vx artifacts in any server speaking Turbo's `/v8/artifacts` API — Vercel's hosted cache or a self-hosted implementation of the published OpenAPI spec (Bearer auth, `x-artifact-duration`, HMAC-SHA256 `x-artifact-tag` signatures). The wire is theirs; the bytes are vx's own artifacts under vx's own keys. The server is storage — the other tool cannot read what vx stores there, and vx does not read its entries.

Nothing is on by default. Declare the plugin in `vx.workspace.ts`, **before** the local cache so a remote hit is consulted first, and configure it explicitly:

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

Every option falls back to the tool's own environment variable, so a self-hosted setup carries over unchanged. A token with no `apiUrl` means Vercel's hosted Remote Cache (`https://vercel.com/api`), exactly as it does for `turbo` — so `npx turbo login && npx turbo link`, then `turboCache()` with `TURBO_TOKEN` / `TURBO_TEAM` set, is the whole hosted setup. With no token the plugin **declines** and the run stays local.

| Option            | Environment variable               | Meaning                                                                                                       |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apiUrl`          | `TURBO_API`                        | base URL of the cache server; default with a token: `https://vercel.com/api`; a `user:pass@` in it is refused |
| `token`           | `TURBO_TOKEN`                      | Bearer token on every request                                                                                 |
| `teamId`          | `TURBO_TEAMID`                     | `teamId` query parameter; required with `signatureKey`                                                        |
| `teamSlug`        | `TURBO_TEAM`                       | `slug` query parameter                                                                                        |
| `signatureKey`    | `TURBO_REMOTE_CACHE_SIGNATURE_KEY` | HMAC-SHA256 key (≥ 32 bytes, used raw); a download whose tag does not verify is a miss                        |
| `timeoutMs`       | —                                  | HEAD/GET/POST deadline (default 30 s)                                                                         |
| `uploadTimeoutMs` | —                                  | PUT deadline (default 60 s)                                                                                   |

The signature is Turbo's current scheme (`artifact-signature:v2`: prefix, hash, team id and body, each length-prefixed, under HMAC-SHA256, base64 in `x-artifact-tag`).

Artifacts stream both ways on both wires: an upload sends the local artifact from its file, a download hands vx the response body to write straight to disk. A signed download must verify before vx sees a byte, so it is written to a temp file in the OS temp directory and verified from there (the tag covers the body's length, which a chunked response does not declare up front); a bad tag deletes the temp and reads as a miss, and a good one is handed over as a stream that deletes the temp once it is read or cancelled.

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

The Nx spec has no existence probe, so `has` (the `--dry` prediction and the prefetch pass) is a `GET` whose body the following `get` reuses — one transfer, not two. The wire carries no producing-task duration, so a remote hit reports none.

## Remote-cache behaviour (both)

- A remote error degrades to a **miss** and one warning; the run never fails because of the cache.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process — including the requests already in flight when the refusal lands, which degrade in silence rather than repeating it (a six-project run printed five identical lines before 2026-09-20).
- Policy (`--cache=remote:r`, …) is enforced by core's `LayeredCache`, which the plugins wrap — a read-only token pairs naturally with `remote:r`.

## Testing

`bun test` runs the Turbo and Nx plugins over fixture workspaces (the Nx one against a fake `nx` whose graph export and `runExecutor` are stubs, so the vx → `nx-exec` → executor → cache round trip is real), the migrate CLI over both sources, and each remote-cache wire against a strict in-memory implementation of its spec plus a full `vx run` round trip (miss → upload → local wipe → restore from the server). A separate suite points both plugins at a HOSTILE server — 500 on every request, 401, a server that never answers, and a body that is not an artifact — and pins that each one degrades to a miss with the run still green. `tests/nx-exec-live.test.ts` runs `nx-exec` against REAL Nx when `VX_NX_MODULES` names a directory whose `node_modules` holds `nx`, `@nx/js` and `typescript` (CI installs one under `packages/vx-migrate/.nx-live` and sets `VX_REQUIRE_NX=1`, so an absent install fails there instead of skipping).

## History

`vx migrate` was a core verb until 2026-09-10; it moved here so core reads no other runner's format. `@vzn/vx-turbo`, `@vzn/vx-turbo-cache` and `@vzn/vx-nx-cache` were separate packages until 2026-09-11, when adoption became one package. Typing `vx migrate` prints the pointer here.
