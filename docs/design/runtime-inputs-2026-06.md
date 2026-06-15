# Runtime inputs — design (2026-06)

## Problem

A task's cache key today is derived from declared files, env-var
values, upstream hashes, the resolved config, and the project
`package.json`. There is no way to fold a **computed value produced at
run time** into the key — e.g. the toolchain version (`node -v`,
`rustc --version`), the OS, the current date, or the output of a
content probe against an external system.

Nx supports this as *runtime inputs* (`{ "runtime": "node --version" }`
— run the command, fold its stdout into the hash). Turbo does **not**
(open request: vercel/turborepo#4124; Turbo doesn't even fold the Node
version into its hash).

vx has an *accidental* escape hatch — because the resolved config
object is hashed, a value computed in `vx.config.ts` (e.g.
`execSync('node -v')` baked into `exec.env`) participates in the key.
**But it breaks under `--frozen`**: with a lockfile, config eval
happens once at `vx lock` time and the resolved object is frozen, so
the captured value goes stale until the next relock. We want **one
canonical mechanism** that is correct in every mode, including frozen.

## Key insight: model it on `inputs.env`

`cache.inputs.env` already has exactly the right split:

- the **names** (`['NODE_ENV']`) are part of the resolved config →
  frozen into `vx-lock.json`, auditable;
- the **values** are resolved **live at hash time** from
  `process.env` inside `resolveInputs` (`inputs.ts:81`), so they are
  fresh on every run including `--frozen`.

Runtime inputs are the same shape: freeze the *command strings*,
resolve the *command output* live at hash time. This is the only
mechanism that survives `--frozen` — there is nothing to "freeze"
about the output, so it cannot go stale.

| | frozen in lock | resolved live at hash time |
|---|---|---|
| `inputs.env` | the names `['NODE_ENV']` | the values from `process.env` |
| `inputs.runtime` | the commands `['node -v']` | the command output |

## Schema

Two new optional fields on `CacheInputs`, mirroring the existing
`files` / `workspaceFiles` and `outputs.files` /
`outputs.workspaceFiles` duality:

```ts
interface CacheInputs {
  files: string[]
  workspaceFiles?: string[]
  env?: string[]
  tasks?: readonly string[]
  /**
   * Shell commands run in the PROJECT dir at hash time; their combined
   * (stdout + stderr, trimmed) output is folded into the cache key.
   * Deduped per (projectDir, command) within a run, so build + test +
   * lint in one project share a single spawn. A non-zero exit fails
   * the run. Modeled on `env`: the COMMANDS are frozen in the lock,
   * the OUTPUT is resolved live every run (correct under --frozen).
   */
  runtime?: string[]
  /**
   * Like `runtime`, but commands run at the WORKSPACE ROOT and are
   * deduped GLOBALLY per command across the whole run — so a `node -v`
   * declared in 500 projects spawns exactly once. The runtime-input
   * analog of `workspaceFiles`: per-task, root-anchored.
   */
  workspaceRuntime?: string[]
}
```

Per-task only — no workspace-global config field (consistent with the
owner's rejection of global config inputs; `workspaceRuntime` is
per-task and root-anchored exactly like the shipped `workspaceFiles`).

Loader validation: both are `string[]`, same shape-check and error
messages as `env`. Empty/absent → no runtime contribution, byte-
identical key to before for non-users.

### Naming note

Config fields are `runtime` / `workspaceRuntime` (they hold commands,
parallel to `files` / `workspaceFiles`). The resolved arrays they
produce keep the `…Values` suffix (`runtimeValues` /
`workspaceRuntimeValues`) because those hold `[command, output]` pairs.

## Resolution

`ResolvedInputs` gains two arrays:

```ts
interface ResolvedInputs {
  files: string[]
  envValues: Array<[name: string, value: string]>
  runtimeValues: Array<[command: string, output: string]>
  workspaceRuntimeValues: Array<[command: string, output: string]>
}
```

`resolveInputs` resolves both. Each entry's `output` is the trimmed
`stdout + stderr` of running the command. Both arrays are sorted by
command for deterministic folding.

### Execution — fastest path, blocks only what it needs

- Run via async `Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'pipe',
  stderr: 'pipe', stdin: 'ignore' })` — `sh -c` so pipelines /
  redirects work ("shell is the API"); async (never `spawnSync`) so
  spawns overlap.
- **Two run-scoped dedup memos** threaded through `ComputeHashArgs`
  alongside `gitFilesCache` / `hashCache`:
  - project: `Map<projectDir + '\0' + command, Promise<string>>`
  - workspace: `Map<command, Promise<string>>`
  Each stores a `Promise` — the first task to need a command fires the
  spawn; concurrent tasks await the same promise. Each unique command
  therefore runs **once** per its dedup scope, and distinct commands
  run **concurrently**.
- A task's `computeTaskHash` awaits **only its own** declared
  commands' promises — never the full set — so nothing blocks more
  than it must.
- cwd: `runtime` → `node.projectDir`; `workspaceRuntime` →
  `workspaceRoot`.

### Non-zero exit → hard fail

A command exiting non-zero throws a `UserError` naming the command,
its exit code, and its (trimmed) output. Consistent with vx's
fail-loud stance (e.g. git-missing). A broken probe is a config error
to fix, not a silent cache state. The error rejects the shared
promise, so every task awaiting that command fails identically.

## Key derivation

In `Cache.key` (`cache.ts:642`), fold the two arrays immediately after
`env-values`, as **distinct namespaced sections** so a `runtime`
command and a `workspaceRuntime` command with the same string +
output can never alias (same reasoning as the `outputs/` vs
`workspace-outputs/` namespace split):

```ts
h = xxh3(`runtime-values:${input.runtimeValues.length}`, h)
for (const [c, o] of input.runtimeValues) h = xxh3(`${c}\0${o}`, h)

h = xxh3(`ws-runtime-values:${input.workspaceRuntimeValues.length}`, h)
for (const [c, o] of input.workspaceRuntimeValues) h = xxh3(`${c}\0${o}`, h)
```

`\0` delimiter between command and output (same rule as env values).
`CacheKeyInput` gains the two arrays.

## Lock / `lock --check`

No special handling, none added. The lock stores only the command
strings (they live in the resolved config); `lock --check` re-evals
config and compares — the strings match. Output drift is invisible to
the lock **by design**, identical to how env-*value* drift is
invisible (the lock freezes env *names*, not values). One doc line in
`docs/caching.md` notes this parallel.

## Cache version

Key derivation changes → **CACHE_VERSION bump** via the
`bump-cache-version` skill. **No SCHEMA bump** — no on-disk format
change (artifacts and the SQLite schema are untouched; only the
in-memory key derivation gains two folded sections).

## Testing

Unit (`tests/inputs.test.ts` / a new `tests/runtime-inputs.test.ts`):
- a unique command runs exactly once per dedup scope (inject latency;
  guard a spawn counter — fails if dedup removed);
- distinct commands run concurrently;
- project dedup keys on `(projectDir, command)`; two projects with the
  same `runtime` command spawn twice, same `workspaceRuntime` command
  spawns once;
- output folding is sorted + namespaced (a `runtime` vs
  `workspaceRuntime` command with identical string+output derive
  different keys);
- combined stdout+stderr is captured and trimmed;
- non-zero exit throws `UserError` naming the command;
- absent fields → key byte-identical to pre-change.

e2e (`tests/orchestrator*.test.ts`):
- changing a command's output across runs flips the key (cache miss);
- a `--frozen` run re-resolves the output live (the headline
  correctness property — escape hatch can't do this);
- `workspaceRuntime` command shared by N projects spawns once on
  a real CLI run.

## Docs

- `docs/schema.md` — the two fields.
- `docs/caching.md` — invalidation-table rows + the env-parallel
  asymmetry note (commands frozen, output live).
- `docs/cli.md` — only if a flag interaction surfaces (none expected).
- CLAUDE.md decision-log entry.

## Out of scope (YAGNI)

- Workspace-global `globalRuntime` applied to every task
  (rejected global-config-inputs territory; use a shared imported
  preset for reach).
- Timeouts / caching command output across runs (a runtime input is
  *defined* by re-resolving every run).
- Per-command cwd override (the two-field split is the cwd control).
