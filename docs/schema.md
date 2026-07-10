# Config schema

Complete reference for every field accepted by `vx.config.{ts,mts,js,mjs}`
and the optional workspace-level `vx.workspace.{ts,mts,js,mjs}`. The
authoritative TypeScript definitions live in `src/config.ts` and are
re-exported from `@vzn/vx`.

## File layout

```
<workspaceRoot>/
├── pnpm-workspace.yaml          (or: package.json with "workspaces", or bare package.json)
├── vx.workspace.ts              (optional, workspace-wide settings)
└── packages/
    └── <pkg>/
        ├── package.json
        └── vx.config.ts         (per-package task definitions)
```

A project is discovered as a vx project by the **presence of a
`vx.config.*` file alongside the project's `package.json`.** Projects
without a config are visible in the workspace graph but contribute no
tasks.

## Project config

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    <taskName>: TaskConfig,
    ...
  },
})
```

`defineProject` is an identity function — it exists purely so
TypeScript narrows literal types in your config (clean autocomplete,
strict validation against the schema). It has zero runtime effect.

`tasks` is a `Record<string, TaskConfig>`. Task names are arbitrary
strings; they're referenced by `dependsOn`, by `cache.inputs.tasks`,
and by the CLI (`vx run <taskName>` or `vx run <pkg>#<taskName>`).

## `TaskConfig`

```ts
interface TaskConfig {
  description?: string // one-line blurb for the picker / --dry view
  exec?: ExecConfig // omit to declare a group task
  dependsOn?: readonly string[] // Turbo/Nx micro-syntax
  cache?: CacheConfig // caching is opt-in; requires `exec`
  sandbox?: SandboxConfig // opt-in OS sandbox; requires `exec`
}
```

A task either has an `exec` (it does work) or omits `exec` and declares
`dependsOn` (it's a **group task**, a pure aggregator). The loader
rejects a task that has neither — a no-op standalone task is almost
always a config mistake.

### `description` (optional)

```ts
description?: string
```

A short one-line blurb describing what the task does. Pure metadata —
no effect on caching, scheduling, or execution. Surfaced in three places:

- The interactive task picker (`vx run` with no positional in a TTY) —
  printed to the right of each `pkg#task` id.
- The `--dry` text preview — printed on a second indented line under
  the cache-status row.
- The `--dry=json` output — `description` lives on each task entry.

```ts
test: {
  description: 'bun test against the tests/ tree',
  exec: { command: 'bun test' },
  cache: {
    inputs: { files: ['src/**', 'tests/**'] },
    outputs: { files: [] },
  },
}
```

### `exec` (optional — required for non-group tasks)

```ts
interface ExecConfig {
  command: string // shell command, run from the project's dir
  env?: ExecEnv // optional per-task env layering
  timeout?: number // ms before vx SIGTERMs the child (see below)
  retries?: number // max additional attempts after a failure (see below)
  resources?: ResourcesConfig // CPU/memory reservations for admission (see below)
  persistent?: PersistentConfig // long-running task (dev server, watcher)
}
```

`command` is a string. Run via `Bun.spawn` with `shell: true`, so POSIX
shell semantics work directly — pipes, redirects, `&&` chaining:

```ts
exec: {
  command: 'tsc -b'
}
exec: {
  command: 'gen && tsc && cp -r assets dist/'
}
exec: {
  command: 'find src -name "*.snap" | xargs rm -f'
}
```

CLI args after `--` are appended to `command`, shell-quoted via
`JSON.stringify(arg)`:

```sh
vx run test -- --bail --watch
# child sees:   bun test "--bail" "--watch"
```

Forwarded args are folded into the cache key — different args produce
distinct cache entries.

#### `timeout` (optional)

Maximum time in milliseconds before vx SIGTERMs the child. Omitted →
no limit.

```ts
build: { exec: { command: 'tsc -b', timeout: 120_000 } }
```

- For a **normal task**, `timeout` bounds the total run time. A task
  that overruns is killed and reported `failed` (timed out) — never
  cached. (A timeout SIGTERM is a real failure, distinct from a Ctrl-C
  teardown, which is reported `aborted`.)
- For a **persistent task**, `timeout` bounds the **readiness wait**
  instead: if `readyWhen` hasn't matched within the window the child is
  SIGTERMed and the task fails — see `persistent` below. A persistent
  task that's ready on spawn (no `readyWhen`) becomes ready before the
  timer can fire, so the timeout is a no-op for it.

A task with **no** `exec.timeout` falls back to a run-level default, if
one is set. Precedence, highest first: **per-task `exec.timeout` →
`--timeout <ms>` / `RunOptions.timeout` → `VX_TASK_TIMEOUT` env →
workspace `timeout`** (see workspace config below). Per-task always
wins. The run-level defaults are threaded as run options, so — like
`--retry` — they never touch a cache key: a `--timeout` run cache-hits a
plain run's entry.

**Why no multi-step `commands: string[]`?** Per-task caching is the
right granularity for invalidation. If you'd benefit from caching each
step independently (e.g. `codegen` then `build`), split into two
tasks linked by `dependsOn`. If you don't need that, `&&` in shell is
the right tool.

#### `retries` (optional)

Maximum ADDITIONAL attempts after a failed attempt. `retries: 2` means
up to 3 executions total. `0` / omitted → no retries (fail on the first
non-zero exit).

```ts
test: { exec: { command: 'bun test', retries: 1 } }
```

- A retry fires after ANY failure, `timeout` kills included. A Ctrl-C
  teardown (`aborted`) is never retried — the run is tearing down.
- Declared outputs are re-cleaned before each retry, exactly like the
  first attempt — a failed attempt's partial outputs can't leak into
  the next.
- Every attempt streams its output live. Between attempts vx emits one
  stderr line into the task's stream:
  `vx: retrying <id> (attempt <k>/<total>) after exit <code>`.
- The final outcome is the LAST attempt's: the first success wins (and
  is what gets cached — its stdout only, not a concatenation of failed
  attempts); if every attempt fails, the task is `failed` with the last
  exit code and nothing is cached, as today.
- `retries` is part of the resolved config, so declaring it derives a
  distinct cache key (like every config field); tasks without it keep
  byte-identical keys.
- Not allowed with `persistent` — a persistent task has no exit to
  retry (config error, like `cache` + `persistent`).

The run-level default is `vx run --retry <n>` — it applies to tasks
that don't declare their own `retries`; explicit config always wins,
including an explicit `retries: 0`. The CLI flag never affects cache
keys.

#### `resources` (optional)

```ts
interface ResourcesConfig {
  cpus?: number | string // CPU units (fractional ok) or "<n>%" of the CPU budget
  memory?: number | string // bytes, "512MB"/"2GB" (powers of 1024), or "<n>%" of RAM
}
```

Resource **reservations** for scheduling admission. A task declares how
much CPU / memory it needs, and the scheduler packs ready tasks so
concurrent reservations never exceed a budget on either axis — a 12 GB
linker and a 6-core type-check no longer count the same as a near-free
`lint`. Turbo and Nx have nothing comparable (flat task-count
concurrency only); Bazel's local resources are the precedent.

```ts
test: {
  exec: {
    command: 'vitest run integration',
    resources: { cpus: 4, memory: '2GB' }, // or { cpus: '50%', memory: '25%' }
  },
}
```

- **Admission control, NOT enforcement.** vx uses the numbers only to
  decide what to co-schedule — it does not cgroup-limit, `nice`, or
  kill a task that exceeds its declaration (that stays the job of
  `exec.timeout` and the OS).
- **Default `0` = reserve nothing, run freely.** A task that omits the
  field (or declares `0`) is gated only by the concurrency-count limit.
  Reservations coordinate among tasks that opt in; every existing
  config schedules byte-identically.
- **Budgets:** `cpus` percent resolves against the run's `concurrency`;
  `memory` percent against total system RAM, overridable with
  `vx run --memory <size>`. **Container caveat:** in a cgroup-limited
  container `os.totalmem()` reports the HOST's RAM — pass `--memory`
  with the real limit in CI containers.
- **Never blocks the run:** a reservation larger than the whole budget
  is admitted alone (when nothing else holds that axis), so an
  over-declared task still runs — one at a time — instead of
  deadlocking. Confirmed cache restores reserve nothing (a restore is a
  tar extract, not the task's real work).
- **Never busts a cache:** the whole `resources` object is stripped
  from the cache key — it's a scheduling hint with zero effect on
  outputs, so tuning a reservation re-uses every existing entry.

#### `persistent` (optional)

```ts
interface PersistentConfig {
  readyWhen?: string // regex (as string); first matching output marks ready
}
```

Marks the task as a long-running process — a dev server, a file
watcher, a daemon. The runner spawns the command but does NOT wait
for it to exit. Instead it considers the task "ready":

- Immediately on successful spawn when no `readyWhen` is given.
- On the first stdout/stderr output that matches the `readyWhen`
  regex string. The match also sees a trailing partial line, so
  prompt-style banners without a newline (`printf 'Listening on
:3000'`) count.

```ts
dev: {
  exec: {
    command: 'vite',
    timeout: 30_000, // bound the readiness wait
    persistent: { readyWhen: 'Local:' },
  },
}

watch: {
  exec: {
    command: 'tsc --watch --preserveWatchOutput',
    persistent: { readyWhen: 'Watching for file changes' },
  },
}

// No readyWhen — ready as soon as spawn succeeds. Useful for daemons
// that have no observable "ready" signal but downstream doesn't need
// to gate on one.
agent: {
  exec: {
    command: 'my-agent --daemon',
    persistent: {},
  },
}
```

Semantics:

- **Downstream unblocks on ready, not on exit.** Useful for e2e tests
  that need a dev server up first:
  ```ts
  'dev:run':  { exec: { command: 'vite', persistent: { readyWhen: 'Local:' } } },
  'e2e':      { dependsOn: ['dev:run'], exec: { command: 'playwright test' } },
  ```
- **Exit before ready ⇒ failed.** If the persistent task crashes or
  exits before `readyWhen` matches, the task is reported as `failed`.
- **End-of-graph SIGTERM.** Once the rest of the graph finishes
  (success OR failure of downstream), the orchestrator sends `SIGTERM`
  to every persistent subprocess and waits for them to exit before
  returning.
- **`cache` is rejected.** The config loader throws on
  `cache + persistent` — persistent tasks don't terminate, so there's
  no exit code to cache and no outputs to capture at a well-defined
  moment.

#### `ExecEnv` (optional)

```ts
interface ExecEnv {
  passThrough?: string[] // names taken from host process.env
  define?: Record<string, string> // explicit name=value pairs
}
```

The child process sees a deliberately limited env. From lowest to
highest priority:

1. **Essential allowlist** (hard-coded in `src/exec/env.ts`): `PATH`,
   `HOME`, `SHELL`, `TMPDIR`, `LANG`, `TERM`, `COLORTERM`,
   `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`, plus Windows
   essentials like `SYSTEMROOT` / `USERPROFILE`. Without these,
   typical CLI tools break.
2. **`passThrough`** names → value taken from host `process.env` at
   spawn time. _NOT_ folded into the cache key — for secrets,
   regional values, CI flags that legitimately vary between machines.
3. **`define`** → explicit literal values. _ARE_ folded into the
   cache key via the task config hash (the values are in your config
   file, so they participate naturally).

```ts
exec: {
  command: 'bun test',
  env: {
    passThrough: ['CI', 'GH_TOKEN'],  // values forwarded; cache-invariant
    define: { NODE_ENV: 'test' },      // literal; in the cache key
  },
}
```

Anything outside these three layers is invisible to the child. This
matches Turbo's `passThroughEnv` semantics and exists for two reasons:

- **Cache stability.** If every host env var entered the key, every
  shell with a different `PS1` would cache-miss.
- **Determinism.** If host env leaked into the child, two machines
  with different `FOO=bar` set would produce different outputs and
  the user would never know why.

A `<projectDir>/node_modules/.bin` directory is automatically
prepended to `PATH` so locally-installed tools (`oxlint`, `vite`,
etc.) work without `npx`. Only the project's own bin — _not_ the
workspace root's — so sibling-project bins stay invisible (project
isolation).

### `dependsOn` (optional)

Tasks that must complete successfully before this task runs.
Turbo/Nx-style micro-syntax — a flat array of strings:

```ts
dependsOn?: readonly string[]
```

| Form         | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `'name'`     | Same-project task `name`.                                          |
| `'^name'`    | The `name` task in the nearest workspace deps that declare it.     |
| `'pkg#name'` | The `name` task in a specific other package (cross-project edge).  |
| `'name.*'`   | Every OTHER same-project task matching the pattern (`*` = any).    |
| `'^name.*'`  | All matching tasks of the nearest deps that declare any (pattern). |

Examples:

```ts
dependsOn: ['build'] // same-project build first
dependsOn: ['^build'] // build in every workspace dep first
dependsOn: ['codegen', '^build'] // both
dependsOn: ['lib#build', 'shared#test'] // cross-project edges
dependsOn: ['lint.*'] // every lint.<x> task in this project
dependsOn: ['^build.*'] // all build.<x> tasks of the nearest deps
```

Semantics:

- **Same-project (`'name'`)** — name must exist in this project's
  `tasks` map; missing is a hard error at graph-build time. When the
  config is authored through `defineProject`, a bare entry is also
  **type-checked against this config's task keys** — a typo is a
  compile error (`'^name'` / `'pkg#name'` reference other projects
  and stay free strings).
- **`'^name'`** — nearest-holder frontier. Walk the package dep graph
  from this project's direct deps; each path stops at the first dep
  that declares the task and an edge is added to it (Turbo/Nx
  direct-deps parity). The holder's own `dependsOn` is responsible
  for anything deeper — chain `'^name'` in the holder to keep the
  cascade going (the universal pattern). Deps that don't declare the
  task are passed through, so a sparse dep doesn't break ordering to
  deeper packages that do (sparse tasks across a workspace are normal
  — not every package has a `lint`).
- **`'pkg#name'`** — missing pkg or task is a hard error (you named
  them explicitly).
- **Patterns (`'name.*'` / `'^name.*'`)** — `*` matches any run of
  characters in a task NAME; everything else is literal (the dotted
  namespace convention needs no escaping). A same-project pattern
  expands to every other matching task (the declaring task never
  matches itself); **zero matches is legal** — a preset-spread pattern
  needn't match in every project. A `'^pattern'` walks the same
  nearest-holder frontier as `'^name'`, where a holder is a dep
  declaring at least one matching task; the holder receives edges to
  ALL its matches and stops the walk. Patterns are not supported in
  the `'pkg#task'` form. (Nx 19.5 `build-*` parity.)
- **No bare wildcards or negation here.** `'*'` / `'^*'` / `'!form'`
  belong in `cache.inputs.tasks` (filtering which upstream hashes
  participate in this task's cache key), not in `dependsOn` (declaring
  graph edges). The micro-syntax parser rejects them in this position.
- **Cycle detection** runs across the resolved graph at the end of
  `buildTaskGraph`. Cycles throw with a path-formatted message.

### `cache` (optional)

```ts
interface CacheConfig {
  inputs: CacheInputs // required when `cache` is provided
  outputs: CacheOutputs // required when `cache` is provided
}
```

**Caching is opt-in.** Omit `cache` and the task always runs (no read,
no write). Provide it and caching is active for that task. The
project loader requires _both_ `inputs` and `outputs` when `cache` is
set — declaring "what does this read?" and "what does it produce?" is
a deliberate, conscious choice.

**Why opt-in?** Defaulting caching to ON with implicit "all files / no
outputs" silently produces stale builds the moment a user forgets
to revisit the config. The cost of a single forgotten cache miss
(re-run a task) is much less than the cost of a stale cache hit
(ship broken artifacts).

#### `CacheInputs`

```ts
interface CacheInputs {
  files: string[] // required
  workspaceFiles?: string[] // optional; workspace-root-relative
  env?: string[] // optional
  runtime?: string[] // optional; project-dir shell commands
  workspaceRuntime?: string[] // optional; workspace-root shell commands
  tasks?: readonly string[] // optional; same micro-syntax as dependsOn
}
```

##### `inputs.files` (required)

Project-relative globs. `!`-prefix negates.

```ts
files: ['**/*'] // all project files
files: ['src/**', '!**/*.test.ts'] // narrow with exclusion
files: [] // no file inputs at all
files: ['src/**', 'tsconfig.json', 'package.json'] // specific paths
```

Empty array is valid — the cache key still incorporates command, env,
upstream hashes, workspace fingerprint, and the project's
package.json. A task with no _file_ inputs (e.g. a pure
"download-and-verify") still cache-misses on a lockfile change.

Always applied to every glob pass (regardless of what you wrote):

- **gitignore filter** — workspace-root + project `.gitignore`.
- **Always-ignored** — `node_modules/**`, `.git/**`, `.vx/**`,
  `*.tsbuildinfo`.
- **Declared `outputs.files`** are excluded — a task never invalidates
  itself via its own output.
- **Nested-project subtree** — files belonging to a project rooted
  inside this one's dir are excluded. No cross-project leakage via
  globs; the only cross-project relationship is `dependsOn` +
  upstream-hash propagation.

##### `inputs.workspaceFiles` (optional, default `[]`)

Workspace-root-relative globs — the Turbo `$TURBO_ROOT$` / Nx
`{workspaceRoot}` equivalent, for inputs that live outside the project
dir (a root `tsconfig.base.json`, shared codegen output, …). Same
syntax as `files` (`!` negation, last-write-wins), same git-aware
resolution (tracked + untracked-not-ignored; gitignored files are
invisible), and the resolved paths join the same cache-key file list.

```ts
inputs: {
  files: ['src/**'],
  workspaceFiles: ['tsconfig.base.json', 'shared/**', '!shared/README.md'],
}
```

**No boundary rule — deliberate escape hatch.** Unlike `files`,
`workspaceFiles` globs may match files anywhere in the workspace,
including inside other projects' directories. That's bad practice
(prefer project-relative declarations plus `dependsOn` + upstream-hash
propagation for cross-project relationships), but it is there for the
cases that genuinely need root-anchored inputs. The hard
project-boundary rule continues to apply to project-relative `files`
globs only.

Still applied: the always-ignored set (`node_modules/**`, `.git/**`,
`.vx/**`, `*.tsbuildinfo`) and the task's own declared
`outputs.workspaceFiles` (a task never invalidates itself).

`vx watch`: when any config declares `inputs.workspaceFiles`, the loop
watches the workspace root recursively (any file can be an input once
boundaries are off), so root-subdir changes re-trigger cycles like any
other edit. The always-ignored set still filters the noise.

##### `inputs.env` (optional, default `[]`)

Env var names whose host values are folded into the cache key.
**Independent of `exec.env`:**

- Listing a name in `exec.env.passThrough` does NOT make its value
  affect the cache.
- Listing a name here does NOT forward it to the child process.

To both forward AND track, list it in both places. Yes, the
double-declaration is mild noise; a preset helper
(`envTracked('NODE_ENV')`) can sugar it.

```ts
inputs: {
  files: ['src/**'],
  env: ['NODE_ENV', 'TARGET_BROWSER'],  // changes here bust the cache
}
```

A cache-input env var the task actually reads must ALSO appear in
`exec.env.passThrough` (or `define`) — the child environment is
isolated, so without it the key varies on a value the command never
sees. Tracking-only declarations (an env var that influences inputs
some other way) are legal but rare; if in doubt, declare both.

Unset names contribute the empty string to the key — and that's
distinguishable from a name that was never listed (the count of names

- the names themselves are also in the key).

##### `inputs.runtime` (optional, default `[]`)

Shell commands whose **combined, trimmed stdout + stderr** is folded
into the cache key — the runtime-output analog of `inputs.env`. The Nx
[`runtime` input](https://nx.dev/recipes/running-tasks/configure-inputs)
equivalent (Turbo has no built-in for this — see
[vercel/turborepo#4124](https://github.com/vercel/turborepo/issues/4124)).
Use it for tool/runtime versions, OS info, or a project-local probe
script whose value should bust the cache when it changes.

```ts
inputs: {
  files: ['src/**'],
  runtime: ['./scripts/probe.sh', 'rustc --version'],
}
```

Semantics:

- Each command runs in the **project dir** (cwd = the project's
  directory), via `sh -c`, so pipelines and redirects work ("shell is
  the API"). Deduped per `(projectDir, command)` within a run — a
  command declared by both `build` and `test` in the same project runs
  once.
- The **output is resolved live at hash time on every run** (inside
  `resolveInputs`), exactly like `inputs.env` reads host env values
  live. `vx lock` freezes the command _strings_ (they're in the
  resolved config), not their output, so the field stays correct under
  `vx run --frozen` — the changed output of a frozen command still
  busts the cache.
- A **non-zero exit fails the run** (a hard `UserError` naming the
  command and exit code) — fail-loud, like a missing git binary. A
  flaky probe should not silently degrade to a stale hit.
- The command **inherits vx's full environment**, _not_ the isolated
  env that task `exec` commands get. This is deliberate — `node -v` /
  `rustc --version` need the real `PATH` and toolchain env. The flip
  side (same as `inputs.env`): an env var that differs between machines
  silently changes the key; declare such inputs explicitly if you want
  them visible.
- The command **runs whenever a task's key is derived** — that's every
  run (warm runs included, since the key decides hit vs miss), plus
  `vx run --dry` / `--graph` (which predict the key) and `vx run
--no-cache` (which still derives the key). Keep runtime commands pure
  probes with no side effects.
- The command runs as part of **hash derivation, before** the task's
  `exec` — so it is **not** constrained by the task's own `sandbox`
  policy (the probe runs unsandboxed even on a sandboxed task).

##### `inputs.workspaceRuntime` (optional, default `[]`)

Like `runtime`, but commands run at the **workspace root** (cwd = the
workspace root) and are deduped **globally per command** across the
whole run — a `node -v` declared in 500 projects spawns exactly once.
The runtime-input analog of `workspaceFiles`: per-task, root-anchored.
Use it for global tool versions, OS info, or any probe whose value is
the same for every project.

```ts
inputs: {
  files: ['src/**'],
  workspaceRuntime: ['node -v'], // runs once per run, root cwd
}
```

Same `sh -c` execution, live-at-hash-time resolution (frozen-safe), and
non-zero-exit-fails semantics as `runtime`. The two fields are folded
into the cache key in **distinct namespaces**, so an identical
`(command, output)` pair never aliases between them.

##### `inputs.tasks` (optional, default = all upstream)

Same micro-syntax as `dependsOn`, plus two filter-only extras:

| Form         | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `'*'`        | Include every same-project upstream hash.      |
| `'^*'`       | Include every dep-workspace upstream hash.     |
| `'name'`     | Include same-project task `name`.              |
| `'^name'`    | Include `name` in every dep workspace.         |
| `'pkg#name'` | Include the specific package's `name` task.    |
| `'!<form>'`  | Exclude — any of the above with a leading `!`. |

Patterns are applied in order; **last write wins**. So
`['*', '^*', '!^noisy']` reads as "all upstream except deps' noisy
task". Defaults:

- **Omitted** → all upstream contribute (`['*', '^*']`). Most common.
- **`[]`** → fully decoupled; no upstream contributes.

Examples:

```ts
tasks: ['^build'] // only ^build from deps; nothing from self
tasks: ['codegen', '^*'] // self.codegen + everything from deps
tasks: ['*', '^*', '!^noisy'] // all upstream except deps.noisy
tasks: ['lib#build'] // a single cross-project hash
tasks: [] // fully decoupled
```

**When to use this:** when a task `dependsOn`s another for ordering
(it has to run after) but the upstream's outputs do NOT affect this
task's outputs. Typical case: an integration-test task `dependsOn`s
`build` for ordering, but its inputs are only the test source — so
`inputs.tasks: []` to keep `build` from invalidating it.

#### `CacheOutputs`

```ts
interface CacheOutputs {
  files: string[] // required
  workspaceFiles?: string[] // optional; workspace-root-relative
}
```

Project-relative globs of files the task produces. Captured on cache
write, restored on cache hit (overwriting any local modifications),
and **wiped before exec AND before restore** so the project dir ends
every run bit-identical to the cached snapshot.

```ts
outputs: {
  files: ['dist/**']
} // typical build output
outputs: {
  files: []
} // tasks with no file output (lint, test)
outputs: {
  files: ['dist/**', 'coverage/**']
}
```

Outputs are **NOT** filtered through gitignore — typical artifact
dirs like `dist/`, `coverage/`, `.next/`, `pkg/` are captured normally
even when gitignored (they usually are).

Empty `[]` is valid for tasks that produce no files (e.g. `lint`,
`typecheck`, `test`); you still cache the no-op success so the next
run is a no-op too.

**Cleaning semantics** (one of vx's strict-output-ownership rules):

- Before exec on a cache miss: the declared output globs are resolved
  and matching files / dirs are wiped. So a leftover `dist/old.js`
  from a prior build can't survive into a fresh build that doesn't
  rewrite it.
- Before restore on a cache hit: same wipe, then files are copied
  from the cache entry into the project dir. The post-restore tree
  is the cached snapshot, byte-for-byte.

Skipped when `cache.outputs.files` is empty (nothing declared as
output) and when no cache-write axis is enabled (e.g. `--no-cache`,
or a read-only `--cache=local:r`) — the user is debugging and
managing the tree themselves. `--force` keeps writes on, so it does
clean.

##### `outputs.workspaceFiles` (optional, default `[]`)

Workspace-root-relative globs for outputs the task writes OUTSIDE its
project dir (e.g. a root-level generated file). Same capture / restore
/ wipe semantics as `files`, anchored at the workspace root; packed
into the artifact under a separate `workspace-outputs/<rel-to-root>`
namespace so project and workspace outputs never collide.

```ts
outputs: {
  files: ['out.txt'],
  workspaceFiles: ['generated/**'],
}
```

**No boundary rule — deliberate escape hatch.** These globs may
capture (and on restore, overwrite; on clean, wipe) files anywhere in
the workspace, including inside other projects' dirs. Prefer
project-relative `files` whenever the task can write inside its own
dir. Two tasks declaring overlapping workspace outputs is user
responsibility — vx does not police it; last restore wins.

### `sandbox` (optional)

Opt a task into an OS-level sandbox. Requires `exec`; silently skipped for
persistent tasks. **Opt-in per task — omit it and the task runs
unsandboxed.** Full walkthrough in the
[sandboxing guide](https://vznjs.github.io/vx/guides/sandboxing/).

```ts
interface SandboxConfig {
  // Filesystem — paths are project-relative / absolute / `~`-expanded.
  // NO globs (bwrap accepts path prefixes only).
  allowRead?: string[] // extra readable paths beyond resolved cache.inputs.files
  allowWrite?: string[] // extra writable paths beyond the cache.outputs.files prefix
  allowGitConfig?: boolean // permit writes to .git/config (default false)

  // Network — blocked by default.
  network?: boolean | SandboxNetworkConfig // false (default) | true | fine-grained

  // Process behavior.
  allowPty?: boolean // acquire a TTY (default false)
  enableWeakerNestedSandbox?: boolean // Linux: nested sandboxes (default false)
  enableWeakerNetworkIsolation?: boolean // macOS: host-proxy net, lower isolation (default false)

  // Silence known-noisy probes: command-substring → paths to ignore.
  ignoreViolations?: Record<string, string[]>
}

interface SandboxNetworkConfig {
  allowedDomains?: string[] // wildcards ok: `*.example.com`, `*`
  deniedDomains?: string[] // evaluated before allowedDomains
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  allowLocalBinding?: boolean // bind localhost ports (e.g. a self-querying test server)
  allowMachLookup?: string[] // macOS only
}
```

**Baseline** (`sandbox: {}`): read only resolved `cache.inputs.files`,
write only the static prefix of `cache.outputs.files` (a task with empty
outputs writes nowhere), no network. No inheritance, no workspace
defaults, no built-in escapes — declare everything explicitly.

**Policy: fail on violation.** An undeclared read/write (macOS log
monitor) or a child that fails because it couldn't reach a path (Linux
bwrap structural deny) fails the task; a failed task is never cached.
Activation is lazy (only when some task declares `sandbox`); on an
unsupported platform a sandboxed task fails fast rather than running
unsandboxed. Linux needs `bubblewrap` + `socat` installed.

## Group tasks (no `exec`)

A task with no `exec` and a non-empty `dependsOn` is a **group task**
— a pure aggregator. Running a group is equivalent to running its
dependencies; nothing else happens (no spawn, no I/O, no cache
read/write).

```ts
// `vx run install --all`  →  fans out to `build` in every workspace dep
install: {
  description: 'build everything in workspace dependency order',
  dependsOn: ['^build'],
}

// `vx run ci`  →  runs format-check + lint + test in the cwd project
ci: {
  description: 'format-check + lint + test (CI gate)',
  dependsOn: ['format-check', 'lint', 'test'],
}
```

Group tasks:

- **Are not counted in the run summary.** "3 tasks, 2 cached" reflects
  real executable tasks — including a group in the count is confusing
  ("3 of 4 cached" when one was a group that ran nothing).
- **Are not recorded in the `runs` table.** Analytics queries that
  aggregate runtime won't see them.
- **Render no framed block** in the live output.
- **DO contribute a stable hash to downstream tasks** that filter
  `inputs.tasks` to include the group. The hash is rolled up from
  the group's upstream outcomes (sorted, joined, hashed). So any
  change beneath the group cascades correctly.

The loader rejects:

- A task with no `exec` AND no `dependsOn` (literal no-op).
- A `cache` block on a group (nothing to cache).

## Workspace config (`vx.workspace.ts`)

Loaded from `vx.workspace.{ts,mts,js,mjs}` at the workspace root.
**Optional** — when missing, every field falls back to its built-in
default.

```ts
import { defineWorkspace } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'
import { cloud } from '@vzn/vx-cloud/plugin'

export default defineWorkspace({
  concurrency: 8,
  cacheDir: 'build/.vx-cache',
  timeout: 600_000,
  plugins: [otel(), cloud()],
})
```

```ts
interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to navigator.hardwareConcurrency. */
  concurrency?: number
  /** Cache directory, relative to workspace root. Defaults to `.vx/cache`. */
  cacheDir?: string
  /** Default per-task timeout (ms) for tasks without their own exec.timeout. */
  timeout?: number
  /** Run-level plugins (backend / cache / telemetry capabilities). */
  plugins?: readonly Plugin[]
  /** Opt in to history-based predictive scheduler priorities. */
  predictive?: boolean
}
```

- **`concurrency`** — used as the default cap on parallel tasks; the
  CLI `--concurrency <n>` still wins when passed.
- **`timeout`** — the lowest-precedence default per-task timeout (ms),
  applied to any task that declares no `exec.timeout`. Precedence,
  highest first: per-task `exec.timeout` → `--timeout` /
  `RunOptions.timeout` → `VX_TASK_TIMEOUT` env → this. A runaway task is
  SIGTERMed and reported `failed`. Purely a safety net — never folded
  into a cache key (a timed-out task fails and is never cached).
- **`cacheDir`** — relative paths are resolved against the workspace
  root; absolute paths are used as-is. `vx run`, `vx cache prune`,
  and any other reader use the same resolution
  (`src/workspace/workspace.ts:resolveCacheDir`).
- **`plugins`** — the run-level extension points. Each entry is a
  `VxPlugin` object contributing any subset of `backend` (where the
  run executes), `cache` (which cache layer is used), `telemetry`
  (observe-only data export — the canonical path for OTel, vx-cloud,
  or custom sinks), the deprecated `eventSink`, plus optional
  `setup`/`teardown`. First-party plugins: `otel()` from
  `@vzn/vx-otel`, `cloud()` from `@vzn/vx-cloud/plugin`. A plugin
  that declines every capability (e.g. `otel()` with no OTLP
  endpoint configured) costs nothing — a run with no active plugin
  is byte-identical to one with none declared. Plugins observe and
  route; they never change how a task executes.
- **`predictive`** — **experimental, unbenchmarked.** When `true` and
  `cache.db` has prior runs, the scheduler picks the next ready task
  by expected remaining critical-path duration (history p50s)
  instead of the static reverse-deps count. Fails open: any error in
  history loading degrades to the baseline heuristic.

The loader validates the shape (positive integer for `concurrency`,
string for `cacheDir`, plugin objects with a name and at least one
capability, boolean `predictive`) and throws a `UserError` on
malformed input.

There are no workspace-level `globalInputs` / task-default fields:
root-anchored file inputs are declared per task via
`cache.inputs.workspaceFiles`, root-anchored probes via
`cache.inputs.workspaceRuntime`, and shared task shapes compose
through plain TypeScript (import a preset and spread it) — the
language replaces Nx-style `namedInputs` / `targetDefaults` schema
machinery by design.

## Helpers

```ts
import { defineProject, defineWorkspace } from '@vzn/vx'

// Identity functions; their purpose is type inference.
defineProject<T extends ProjectConfig>(config: T): T
defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

Use them so TypeScript narrows literal types in your config —
autocomplete for task names in `dependsOn` against your declared
tasks, strict validation against the schema, errors at edit time
rather than at `vx run` time.

You _can_ skip the helpers and write
`export default { tasks: { … } }`, but the IDE experience is
strictly worse.

## Full example

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    // Real cached task with file inputs, env tracking, and outputs.
    build: {
      description: 'compile TypeScript to dist/',
      // NODE_ENV is a cache input below, so it must reach the child
      // too — the exec env is isolated, not inherited.
      exec: { command: 'tsc -b', env: { passThrough: ['NODE_ENV'] } },
      dependsOn: ['^build'],
      cache: {
        inputs: {
          files: ['src/**', '!**/*.test.ts', 'tsconfig.json'],
          env: ['NODE_ENV'],
        },
        outputs: { files: ['dist/**'] },
      },
    },

    // Cached, depends on upstream build; CI is in passThrough only
    // (CI=1 shouldn't bust the cache — it's true on every CI run).
    test: {
      description: 'run unit tests',
      exec: { command: 'bun test', env: { passThrough: ['CI'] } },
      dependsOn: ['build'],
      cache: {
        inputs: { files: ['src/**', 'tests/**'] },
        outputs: { files: [] },
      },
    },

    // Cross-project edges. The pkg.tgz from one project's build is
    // cached, and depends on builds in every workspace dep.
    package: {
      description: 'pack the npm tarball',
      exec: { command: 'rm -rf pkg && npm pack --pack-destination ./pkg' },
      dependsOn: ['build', 'test'],
      cache: {
        inputs: {
          files: ['package.json'],
          tasks: ['build', '^build'], // hash these upstream too
        },
        outputs: { files: ['pkg/*.tgz'] },
      },
    },

    // Persistent dev server. Downstream tasks unblock on the
    // "Local:" line, not on exit (which never comes).
    dev: {
      description: 'vite dev server',
      exec: {
        command: 'vite',
        timeout: 30_000,
        persistent: { readyWhen: 'Local:' },
        env: { passThrough: ['VITE_API_URL'] },
      },
    },

    // E2E test gated on the dev server. Together: vx run e2e runs
    // dev → e2e; e2e exits → orchestrator SIGTERMs dev → run ends.
    e2e: {
      description: 'end-to-end tests against dev server',
      exec: { command: 'playwright test' },
      dependsOn: ['dev'],
    },

    // Pure group task — `vx run ci` fans out, the group itself is
    // silent in the run output.
    ci: {
      description: 'format-check + lint + test',
      dependsOn: ['format-check', 'lint', 'test'],
    },
  },
})
```

## Common patterns

### Sharing inputs across tasks

TypeScript composition is the mechanism (named-input schema machinery
was deliberately rejected — the language already does this). Plain TS
arrays:

```ts
const srcInputs = ['src/**', 'tsconfig.json']

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc' },
      cache: { inputs: { files: srcInputs }, outputs: { files: ['dist/**'] } },
    },
    test: {
      exec: { command: 'bun test' },
      cache: { inputs: { files: [...srcInputs, 'tests/**'] }, outputs: { files: [] } },
    },
  },
})
```

### Presets

A preset is a TypeScript function that returns a `TaskConfig`:

```ts
// presets/ts-build.ts
import type { TaskConfig } from '@vzn/vx'

export function tsBuild(opts?: { tsconfig?: string }): TaskConfig {
  return {
    description: 'compile TypeScript',
    exec: { command: `tsc -b ${opts?.tsconfig ?? ''}`.trim() },
    cache: {
      inputs: { files: ['src/**', opts?.tsconfig ?? 'tsconfig.json'] },
      outputs: { files: ['dist/**'] },
    },
  }
}
```

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'
import { tsBuild } from '../../presets/ts-build.ts'

export default defineProject({
  tasks: {
    build: tsBuild(),
    test: {
      exec: { command: 'bun test' },
      dependsOn: ['build'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
})
```

When the preset is consumed at config-load time, it should resolve
to `.ts` source — see
[`architecture.md` § Config-time imports](./architecture.md#config-time-imports--the-bootstrap-problem)
for the bootstrap-cycle tradeoff.

### When to use `cache.inputs.tasks: []`

When a `dependsOn` exists for ordering only, and the upstream's
output doesn't influence this task's output. Common case: an
integration test that depends on a dev server starting up but whose
own inputs are just the test source.

```ts
e2e: {
  dependsOn: ['dev'],
  exec: { command: 'playwright test' },
  cache: {
    inputs: {
      files: ['e2e/**'],
      tasks: [],   // dev's hash does not affect e2e's cache identity
    },
    outputs: { files: ['playwright-report/**'] },
  },
}
```

### When to use `--no-cache` instead of removing `cache`

`--no-cache` is a runtime flag, not a config change. Reach for it
when:

- You suspect cache corruption and want a clean run.
- You're benchmarking and need fresh timings.
- You're forwarding one-off args and don't want to pollute the cache
  with a one-shot key (though note: forwarded args are already in
  the key, so they form their own entry anyway).

It applies to the whole run; per-task opt-out belongs in config (omit
the `cache` block).

## Schema validation errors

The loader (`src/workspace/project-loader.ts`) validates at load time
and surfaces `UserError` (clean output, no stack):

| Symptom                                                                             | Cause                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| `did not export a default object`                                                   | Forgot `export default`, or exported a non-object. |
| `tasks must be an object`                                                           | `tasks` field is missing or not an object.         |
| `tasks.<name> must be an object`                                                    | The task value is null / a string / etc.           |
| `exec must be an object with a command string`                                      | `exec` is malformed.                               |
| `exec.command must be a non-empty string`                                           | Forgot `command`, or empty string.                 |
| `exec.persistent must be an object (or omitted)`                                    | Wrong shape.                                       |
| `exec.persistent.readyWhen must be a string regex`                                  | Non-string `readyWhen`.                            |
| `cache is not allowed on a persistent task`                                         | persistent + cache combined.                       |
| `a task with no exec must declare dependsOn`                                        | Group task with no edges.                          |
| `cache requires exec`                                                               | Group task with `cache`.                           |
| `dependsOn must be an array of strings`                                             | Wrong shape.                                       |
| `cache.inputs is required when cache is set`                                        | Forgot `inputs`.                                   |
| `cache.inputs.files must be an array`                                               | Wrong shape.                                       |
| `cache.inputs.runtime must be an array of non-empty shell command strings`          | Non-string / empty entry.                          |
| `cache.inputs.workspaceRuntime must be an array of non-empty shell command strings` | Non-string / empty entry.                          |
| `cache.outputs is required when cache is set`                                       | Forgot `outputs`.                                  |
| `cache.outputs.files must be an array`                                              | Wrong shape.                                       |
| `description must be a string`                                                      | Non-string description.                            |

Workspace-config errors:

| Symptom                                                                              | Cause                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `concurrency must be a positive integer`                                             | `concurrency` is negative, zero, NaN, ...       |
| `timeout must be a positive integer (milliseconds)`                                  | Workspace `timeout` is ≤ 0, NaN, or not an int. |
| `cacheDir must be a string`                                                          | Wrong shape.                                    |
| `plugins must be an array of plugin objects`                                         | Wrong shape.                                    |
| `plugins[i].name must be a non-empty string`                                         | Missing / empty plugin name.                    |
| `plugins[i] must contribute at least one of setup/backend/cache/telemetry/eventSink` | A plugin object with no capability.             |
| `predictive must be a boolean`                                                       | Wrong shape.                                    |
