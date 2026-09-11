# @vzn/vx-migrate

Everything for adopting [`@vzn/vx`](https://github.com/vznjs/vx) from Turborepo or Nx, in one package with zero dependencies:

- **`turbo()`** — run a Turbo repository under vx with nothing written. The plugin fills vx's `project` stage from `turbo.json` and each package's `package.json` scripts. A trial that commits nothing.
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
- The mapping's gaps are the migration's gaps, reported as warnings on every run instead of `TODO(vx-migrate)` comments: `$TURBO_ROOT$` tasks, wildcard env names, negated outputs, unknown turbo keys. `bunx @vzn/vx-migrate --dry` lists the same set once. Each gap is one line per run for every task that carries it, not one per task (n8n marks `dev` and `watch` persistent in most of its 84 packages; astro negates `vendor/**` in the outputs of 57 tasks). A per-package `{ "extends": false }` with nothing else is Turbo's opt-out and maps to no task; with keys, the task runs on those keys alone. A glob that climbs out of the package (`../../packages/app-store/*.generated.ts`) is re-anchored on the workspace root as a `workspaceFiles` glob. A negated output under a literal-rooted one (`dist/**` minus `!dist/**/*.map`) is a todo and the positive glob stays; one against a wildcard-rooted output (medusa's `*/**` minus `!src/**`) makes the task uncached, because the clean before exec would otherwise delete the sources — declare the exact outputs in a vx.config to cache it.
- The cost is the stage's: on a 1,000-package workspace with no `vx.config` files the mapping loads in about 42 ms where 1,000 evaluated configs load in 22, in a run that is otherwise the same ~200 ms warm.
- The mapping is read once per run, never once per process: under `vx watch`, a `package.json` script edit or a per-package `turbo.json` overlay edit is the next cycle's tasks. The root `turbo.json` is no task's input and lives in no project dir, so an edit to it is not a cycle — restart the watch.

### The mapper (`mapTurboWorkspace`)

The plugin and the CLI read a repo the same way: the mapper the plugin runs live is what `bunx @vzn/vx-migrate` writes `vx.config.ts` per package from, splicing Turbo's global fields in as imports of a generated `vx-preset.ts`, where the plugin inlines the values. `splice` is the seam between the two consumers; `uses` names which globals a task drew on. Before 2026-09-10 the mapper lived in `@vzn/vx` itself; until 2026-09-11 the plugin was its own package, `@vzn/vx-turbo`.

Rules:

- **A task exists for a package only when the package declares the script** — Turbo's own rule. An absent script is silent; a script key whose value cannot be a command (a number, `null`, an empty string, an array) produces a `task: null` entry whose todo says why, rather than a config that fails to load.
- **Definition order**: root `name`, then root `pkg#name`, then the package's own `turbo.json` — later overlays win field by field.
- **The command is the script body** with its `pre<name>` / `post<name>` hooks folded in, in that order (npm and pnpm run them around `<name>` without being asked; novu's `prebuild` copies the CSS its `build` inlines), one process less per task than `pnpm run <name>` — except a body that calls yarn's `run` builtin (`run -T rollup -c`, `run clean && run build`; yarn ≥ 2 runs scripts in its own shell), which is `run: command not found` in sh: it runs as `yarn run <name>`, as Turbo and Nx run it, and yarn ≥ 2 runs no hooks, so none are folded there. Same rules for `nx:run-script` below (strapi and novu, 2026-09-11).
- `dependsOn`: `^x` passes through; `pkg#task` is kept only when `pkg` emits `task` (else a todo: edge dropped); a same-package name the package lacks simply has no edge; `$TURBO_ROOT$` deps are a todo (vx has no workspace-root tasks, and root `//#` tasks become a note).
- `inputs`: absent → `**/*` (Turbo's default); `$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/<path>` → `cache.inputs.workspaceFiles` (negation kept); any other `$TURBO_ROOT$` use is a todo. `globalDependencies` land in `workspaceFiles` too.
- `outputs`: `$TURBO_ROOT$/<path>` → `cache.outputs.workspaceFiles`; a negated output is a todo (vx outputs have no negation).
- `env` / `passThroughEnv`: explicit names go to `cache.inputs.env` (env only) and `exec.env.passThrough` (both, plus both globals); a wildcard is a todo. A name both a global list and the task's own list carry is listed once.
- **Two tasks of one package on one output path** (strapi's `build`, `build:code` and `build:types`, all on `dist/**`): vx cleans a task's outputs before it runs and before a restore, so the loader refuses two cached tasks whose outputs provably overlap. The mapping resolves it before the file is written — the task with a `^` edge keeps its cache (the first declared when none has one), the others run uncached with a todo naming the keeper and the fix, their own output path. Same rule for Nx targets.
- `cache: false` or `persistent: true` → no `cache` block; a persistent task gets `exec.persistent: {}` and the consumer's `persistentTodo`.
- `outputLogs: "new-only"` maps to nothing: frames for the tasks that ran and a one-liner per cache hit is vx's default flow already. The other values are per-run in vx, so they are a todo naming the flag (`vx run … --output-logs hash-only`).
- An unknown Turbo key is a todo naming it; `extends` is accepted and ignored (the overlay order above is what it means).

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

Reads the **resolved** project graph only (`.nx/workspace-data/project-graph.json`; export one with `nx graph --file=.nx/workspace-data/project-graph.json`). Targets Nx plugins infer at runtime are frozen as the snapshot saw them. `nx:run-commands` joins its commands, `nx:run-script` is the package's script body with its `pre<name>` / `post<name>` hooks folded in (or `yarn run <name>` when the body calls yarn's `run` builtin; an empty script is the placeholder with a todo), `nx:noop` is a group task, a plain `command` is itself; the well-known executors (`@nx/js:tsc`, `@nx/vite:*`, `@nx/jest:jest`, …) become the command they would have run with a TODO to verify it against the executor's options; anything else is a placeholder with a TODO. Named inputs expand from `nx.json` when readable. The graph's dependency edges are ignored — vx derives package edges from `package.json` — except for one report line counting edges with no manifest counterpart.

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

| Option            | Environment variable               | Meaning                                                                                |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `apiUrl`          | `TURBO_API`                        | base URL of the cache server; default with a token: `https://vercel.com/api`           |
| `token`           | `TURBO_TOKEN`                      | Bearer token on every request                                                          |
| `teamId`          | `TURBO_TEAMID`                     | `teamId` query parameter; required with `signatureKey`                                 |
| `teamSlug`        | `TURBO_TEAM`                       | `slug` query parameter                                                                 |
| `signatureKey`    | `TURBO_REMOTE_CACHE_SIGNATURE_KEY` | HMAC-SHA256 key (≥ 32 bytes, used raw); a download whose tag does not verify is a miss |
| `timeoutMs`       | —                                  | HEAD/GET/POST deadline (default 30 s)                                                  |
| `uploadTimeoutMs` | —                                  | PUT deadline (default 60 s)                                                            |

The signature is Turbo's current scheme (`artifact-signature:v2`: prefix, hash, team id and body, each length-prefixed, under HMAC-SHA256, base64 in `x-artifact-tag`).

## `nxCache()` — an Nx self-hosted remote cache

Store vx artifacts in any server implementing Nx's remote cache OpenAPI spec (`GET`/`PUT /v1/cache/{hash}`, Bearer auth, immutable records — a second write of a hash is `409`, which the plugin treats as done). Same rule: the wire is theirs, the bytes are vx's.

```ts
import { defineWorkspace } from '@vzn/vx'
import { nxCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [nxCache({ server: 'https://cache.example.com', accessToken: process.env.CACHE_TOKEN })],
})
```

Every option falls back to the tool's own environment variable; with nothing configured the plugin **declines** and the run stays local.

| Option        | Environment variable                       | Meaning                                        |
| ------------- | ------------------------------------------ | ---------------------------------------------- |
| `server`      | `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`       | base URL of the cache server                   |
| `accessToken` | `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | Bearer token; omit for a server that runs open |
| `timeoutMs`   | —                                          | per-request deadline (default 30 s)            |

The Nx spec has no existence probe, so `has` (the `--dry` prediction and the prefetch pass) is a `GET` whose body the following `get` reuses — one transfer, not two. The wire carries no producing-task duration, so a remote hit reports none.

## Remote-cache behaviour (both)

- A remote error degrades to a **miss** and one warning; the run never fails because of the cache.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process.
- Policy (`--cache=remote:r`, …) is enforced by core's `LayeredCache`, which the plugins wrap — a read-only token pairs naturally with `remote:r`.

## Testing

`bun test` runs the Turbo plugin over fixture workspaces, the migrate CLI over both sources, and each remote-cache wire against a strict in-memory implementation of its spec plus a full `vx run` round trip (miss → upload → local wipe → restore from the server).

## History

`vx migrate` was a core verb until 2026-09-10; it moved here so core reads no other runner's format. `@vzn/vx-turbo`, `@vzn/vx-turbo-cache` and `@vzn/vx-nx-cache` were separate packages until 2026-09-11, when adoption became one package. Typing `vx migrate` prints the pointer here.
