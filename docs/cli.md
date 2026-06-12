# CLI reference

The `vx` binary is the user-facing entry point. The implementation is
intentionally simple: a hand-rolled argv parser (no commander / yargs)
in `src/cli.ts` dispatches to per-subcommand handlers under
`src/cli/<name>.ts`. The flag surface is aligned with
[Turborepo's `turbo run`](https://turborepo.com/docs/reference/run)
so existing Turbo users can swap in with minimal muscle-memory churn.

```sh
# Standalone binary (no Bun required on target):
curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh

# From source (Bun ≥ 1.3):
bun src/bin.ts --version
```

## Top-level shape

```
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx watch [OPTIONS] TASK [-- forwarded-args...]
vx cache prune [--older-than <duration>] [--max-size <bytes>]
vx lock [--check]
vx migrate [--dry] [--force]
vx show [PROJECT[#TASK]] [--format pretty|json]
vx info
vx stats              # deprecated alias of vx info
vx help
vx --help, -h
vx version
vx --version
```

Multiple positional tasks run in one orchestrator invocation with a
shared task graph: `vx run build lint test` fans out all three across
the resolved project scope. Anchored entries (`pkg#task`) target a
specific project; bare entries follow the usual scope rules
(default = the cwd project; broaden with `--all` / `--filter` /
`--affected`).

(No `-V` for version; `vx --version` only — matches Turbo.)

## `vx run`

```
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
```

Run the named task(s). By default only the project containing the
current working directory is selected — `dependsOn` still expands so
the project's upstream workspace deps run too. Override with `--all`,
`--filter`, `--affected`, or an explicit `pkg#task`.

If no task name is given:

- **In a TTY** — an interactive picker lists every `pkg#task` entry
  across the workspace, prints `description` next to each, prompts
  for a number, runs the chosen one.
- **Not a TTY** — exits `1` with `missing task name (stdin is not a TTY)`.

Exit codes:

| Code | When                                                                 |
| ---- | -------------------------------------------------------------------- |
| `0`  | Every task finished `success` or `cache-hit` (local or remote).      |
| `1`  | At least one task ended `failed` or `skipped`; or parse/setup error. |

### Selection

| Form                          | Effect                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| (default)                     | The project that contains cwd. Errors if cwd is not inside a project. |
| `pkg#task`                    | Just that project.                                                    |
| `--all`                       | Every project that declares the task.                                 |
| `--filter <pat>` (repeatable) | pnpm-style filter DSL (see below).                                    |
| `--affected[=<base>]`         | Sugar for `--filter '[<base>]'` — git-changed projects only.          |

Combining: `--filter` and `--affected` stack (the affected base is
appended as another filter pattern); `--all` overrides scope to the
full workspace.

### Filter DSL (`--filter`)

The full DSL lives in `src/workspace/filter.ts`; this is the user-
facing summary.

| Form            | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `<pattern>`     | Match by package name. `*` is a wildcard (no `/`).                            |
| `./<dir>`       | Match packages whose dir is at or under `<dir>` (relative to workspace root). |
| `{<dir>}`       | Same as `./<dir>`.                                                            |
| `<pattern>...`  | Match + all transitive workspace dependencies.                                |
| `...<pattern>`  | Match + all transitive workspace dependents.                                  |
| `<pattern>^...` | Only the transitive dependencies, excluding the matched package itself.       |
| `...^<pattern>` | Only the transitive dependents, excluding the matched package itself.         |
| `!<pattern>`    | Exclude packages matching `<pattern>`.                                        |
| `[<git-ref>]`   | Projects whose files changed since `<git-ref>` (`main`, `HEAD~5`, …).         |

Examples:

```sh
vx run build --filter @scope/*                # all packages under @scope
vx run build --filter app...                  # app and its transitive deps
vx run build --filter ...util                 # util and everything depending on it
vx run build --filter app^...                 # only app's deps (not app)
vx run build --filter '*' --filter '!docs'    # everything except docs
vx run build --filter '[origin/main]'         # projects with files changed since main
```

### `--affected[=<base>]`

Run the task only in projects whose files changed since `<base>`.

- `--affected` (no value) uses `origin/HEAD`, falling back to
  `HEAD~1` if `origin/HEAD` isn't resolvable.
- `--affected=<ref>` uses the given git ref.

It's a pure sugar for `--filter '[<base>]'`; both are resolved by
`src/workspace/affected.ts` shelling out to `git diff --name-only`.

### Argument forwarding (`--`)

Anything after `--` is forwarded (shell-quoted via `JSON.stringify`)
to the task's `exec.command`:

```sh
vx run test -- --watch              # underlying test runner sees "--watch"
vx run build -- --sourcemap         # build command gets "--sourcemap"
```

Forwarded args are folded into the cache key — different args produce
different cache entries. They scope to user-requested tasks only;
dependsOn-pulled deps don't see them (so upstream cache identity
stays clean).

### Flags

| Flag                              | Type           | Default                         | Description                                                                                                |
| --------------------------------- | -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--filter <pattern>`              | repeatable     | (none)                          | pnpm-style filter DSL (see above).                                                                         |
| `--all`                           | boolean        | off                             | Select every project that declares the task.                                                               |
| `--affected[=<base>]`             | optional value | off                             | Filter to projects changed since `<base>` (default `origin/HEAD`).                                         |
| `--excludeDependencies[=<names>]` | optional value | off                             | Drop `dependsOn` edges. No value = all (just the requested task runs); comma-list = drop only those names. |
| `--concurrency <n>`               | positive int   | `navigator.hardwareConcurrency` | Maximum parallel tasks. `1` serializes.                                                                    |
| `--no-cache`, `--force`           | boolean        | off                             | Skip cache reads AND writes; output globs are NOT cleaned.                                                 |
| `--verbosity <n>`                 | int (0+)       | `0`                             | `1` prints a per-task summary table after the framed blocks; `2+` reserved.                                |
| `--dry[=text\|json]`              | optional value | off                             | Print the task graph + predicted cache hit/miss; skip execution.                                           |
| `--graph[=<path>]`                | optional value | off                             | Emit Graphviz DOT (stdout if no path); skip execution.                                                     |
| `--summarize[=<path>]`            | optional value | off                             | Write per-run JSON to `<cacheDir>/runs/<run_id>.json` (or the explicit path).                              |
| `--profile[=<path>]`              | optional value | off (`profile.json` when set)   | Write Chrome-trace JSON of the run's wallclock spans.                                                      |

Mutual exclusion:

- `--dry` and `--graph` — both skip execution; pick one.
- `--dry` or `--graph` with `--summarize` or `--profile` — the latter
  two need a real run.

Unknown flags are a parse error (`unknown flag: --foo`).

### `--output-logs <mode>`

Per-task output volume for the default logger: `full` (default —
frames for executed work, one-liners for quiet cache hits),
`errors-only` (only failed tasks print; the CI noise budget), `none`
(no per-task output). The header and end-of-run summary always print.

## Planning mode (`--dry`, `--graph`)

Both flags short-circuit execution. They build the full task graph,
compute every task's cache key, and probe the cache to predict the
hit/miss outcome.

```
$ vx run ci --dry
would run:
  ◉  @vzn/vx#format-check  cache hit (local)         02bfe8a9
  ◉  @vzn/vx#lint          cache hit (local)         d66cfed2
  ▶  @vzn/vx#test          cache miss — would exec   68595e49

3 task(s) planned, 2 cache hits (2 local), 1 would run.
```

Status legend:

| Symbol | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| `◉`    | cache hit (local) — entry already in `<cacheDir>/`           |
| `↓`    | cache hit (remote) — entry would be fetched from the layer   |
| `▶`    | cache miss — task would execute                              |
| `·`    | no-cache — task opts out (no `cache` block, or `--no-cache`) |
| `○`    | group task (suppressed in human view; in DOT + JSON)         |

`--dry=json` emits the same data as a structured object:

```json
{
  "tasks": [
    {
      "id": "@vzn/vx#lint",
      "project": "@vzn/vx",
      "task": "lint",
      "description": "oxlint with tsgolint-backed type-aware checks",
      "hash": "d66cfed2...",
      "cacheStatus": "hit-local",
      "deps": []
    }
  ]
}
```

`--graph` prints Graphviz DOT (stdout by default; `--graph=path`
writes a file):

```
vx run ci --graph | dot -Tsvg > graph.svg
vx run ci --graph=graph.dot
```

Node `fillcolor` varies by predicted status (green = local hit,
sky-blue = remote hit, orange = miss, gray = no-cache, fuchsia =
group). Edges are unstyled.

## Run artifacts (`--summarize`, `--profile`)

Both flags add a side-effect after a real run completes. Errors
writing the artifact are surfaced via `vx: failed to write …` but
don't change the run's exit code — the run already happened.

### `--summarize[=<path>]`

Writes a per-run JSON file:

```json
{
  "runId": "01HKQ...",
  "startedAt": "2026-05-13T22:00:00.123Z",
  "endedAt": "2026-05-13T22:00:05.567Z",
  "totalMs": 5443.7,
  "tasks": [
    {
      "id": "@vzn/vx#lint",
      "project": "@vzn/vx",
      "task": "lint",
      "status": "cache-hit",
      "exitCode": 0,
      "durationMs": 4,
      "hash": "...",
      "cpuMs": 123,
      "peakRssBytes": 45678,
      "wallclockStartNs": "12345678",
      "wallclockEndNs": "12356789"
    }
  ],
  "summary": {
    "successful": 3,
    "failed": 0,
    "skipped": 0,
    "cachedLocal": 2,
    "cachedRemote": 0,
    "total": 3
  }
}
```

Default path: `<cacheDir>/runs/<run_id>.json`. hrtime fields are
strings (bigints serialized as strings) to preserve ns precision
through JSON.

### `--profile[=<path>]`

Writes a Chrome-trace JSON of every task's wallclock span. Open in
`chrome://tracing` or https://ui.perfetto.dev.

```json
{
  "traceEvents": [
    {
      "name": "@vzn/vx#lint",
      "cat": "cache-hit",
      "ph": "X",
      "ts": 12345,
      "dur": 4321,
      "pid": 1,
      "tid": 1,
      "args": {
        "exitCode": 0,
        "hash": "...",
        "cpuMs": 123,
        "peakRssBytes": 45678
      }
    }
  ]
}
```

Each project gets a distinct `tid` so concurrent tasks across packages
render on separate lanes. `ts` and `dur` are microseconds derived
from the per-task `hrtime.bigint()` spans the runner captures.
`cat` carries the task's final status (`success`, `cache-hit`,
`cache-hit-remote`, `failed`).

Default path: `profile.json` (cwd-relative).

## Sandbox

Sandbox isolation is opt-in **per task** via a `sandbox: {}` block in
the task's config — there is no `--sandbox` CLI flag. See
[`modules/sandbox-runtime.md`](./modules/sandbox-runtime.md) for the
full reference.

```ts
// vx.config.ts
export default {
  tasks: {
    build: {
      exec: { command: 'tsc' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      sandbox: {
        allowRead: ['../../node_modules'], // workspace-root node_modules
        allowWrite: ['/tmp'],
      },
    },
  },
}
```

Policy: **fail on violation.** The sandbox enforces declared inputs
at the kernel level; any task that tries to read a path it didn't
declare either fails naturally (Linux: `ENOENT` from bwrap's
mount-namespace hide) or is flagged via the macOS violation store
and forced to exit non-zero. No cache is written for a failed task.

`vx run` lazily initialises the sandbox runtime only when at least
one task in the graph declares `sandbox: {}`. If runtime deps are
missing (bwrap on Linux, sandbox-exec on macOS) or the platform is
unsupported, the orchestrator errors out with a clear message before
any task runs.

## `vx watch`

```
vx watch [OPTIONS] TASK [-- forwarded-args...]
```

Run the named task, then re-run it on every filesystem change in the
projects in scope. Press `Ctrl+C` to stop.

```sh
vx watch test                       # cwd project; re-test on changes
vx watch test --all                 # every project that declares `test`
vx watch lint --filter '@scope/*'   # filtered scope
vx watch build -- --sourcemap       # forwarded args carry through every cycle
```

### Lifecycle

1. **Initial run.** Same code path as `vx run` — same scope resolution,
   same task graph, same cache behaviour. The line `vx watch: initial
run...` precedes it.
2. **Watch loop.** After the initial run finishes, every project's
   directory in scope is watched recursively. The workspace root is
   watched (non-recursively) for lockfile / `pnpm-workspace.yaml`
   changes.
3. **On change.** The triggering path is logged
   (`vx watch: <project> <relpath>; re-running...`) and the
   orchestrator is invoked again with the same options. Events arriving
   while a run is in flight queue and drain after the current cycle.
   Re-runs are debounced ~150ms after the last event.
4. **Exit.** `SIGINT` (Ctrl+C) prints `vx watch: stopped` and exits 0.

### Path filtering

Always ignored (no re-trigger):

- `node_modules/`, `.git/`, `.vx/` anywhere in the path.
- Files ending in `.tsbuildinfo` or `~` (editor swap files).

Everything else triggers a cycle. We deliberately don't filter events
against per-task `cache.inputs.files` — the cache hash is the source
of truth. A change to an irrelevant file produces a cache-hit run
(typically tens of ms); the cost is much smaller than the engineering
cost of a per-event glob match.

### Workspace fingerprint changes

Edits to a lockfile (`pnpm-lock.yaml`, `bun.lock`, …) or
`pnpm-workspace.yaml` at the root invalidate every task's cache key
via the [workspace fingerprint](./caching.md#cache-key-derivation).
Watch mode hears those because it watches the workspace root
(non-recursively).

### Constraints

The following flags are rejected (parser exits 1 before the initial
run):

- `--dry` / `--graph` — those skip execution; nothing to watch.
- `--summarize` / `--profile` — would overwrite their target per cycle.

Persistent tasks (`exec.persistent`) re-spawn each cycle: the previous
SIGTERM happens between cycles, then the next cycle launches a fresh
child. For dev-server workflows where you want the server to stay up
across changes, use the dev tool's own watch (`vite`, `tsc -b -w`,
`bun --watch`) rather than `vx watch`.

### Exit codes

- `0` — clean Ctrl+C / SIGTERM exit.
- `1` — parser error or missing scope.

Re-run cycles whose orchestrator returns `{ ok: false }` do NOT exit
the watch loop — a failed cycle just prints the framed FAILED block
and waits for the next change. This matches `turbo watch` / `nx
watch`.

## `vx cache prune`

Evict old or oversized cache entries. Operates on
`<cacheDir>/cache.db` plus the on-disk `<hash>/` directories (each one
carrying its own `outputs/`, `stdout`, and `stderr`).

```
vx cache prune --older-than <duration>     # Drop entries last accessed before now - duration.
vx cache prune --max-size <size>            # After age-based pruning, evict LRU until under <size>.
```

At least one of `--older-than` / `--max-size` is required. Both may
be combined: age-based eviction runs first, then LRU eviction if the
total is still over the size cap.

**Duration units**: `s`, `m`, `h`, `d`. Examples: `30d`, `24h`, `60m`, `30s`.

**Size units**: `K`, `M`, `G`, `T` (powers of 1024). Optional `B`
suffix is accepted. Examples: `500M`, `1G`, `100K`, `2T`, `500MB`.

```
$ vx cache prune --older-than 30d
Pruned 42 entries (1.3 GB freed)

$ vx cache prune --older-than 7d --max-size 500M
Pruned 18 entries (320.1 MB freed)
```

Exit codes:

- `0` — pruning completed (zero or more entries evicted).
- `1` — parse error, missing policy, or workspace-discovery error.

`vx cache prune` resolves the cache directory via
`src/workspace/workspace.ts:findWorkspaceRoot` from cwd. Note: the
prune command currently always uses the default `.vx/cache/`; a
workspace-config `cacheDir` override is not yet honored by this path
(tracked).

## `--frozen` (run flag)

`vx run ... --frozen` loads configs from the committed `vx-lock.json`
instead of evaluating them — CI reproducibility mode. Plain `vx run`
always evaluates live (a byte hash can't see a config's import
closure, so silently consuming the lock locally would risk stale
freezes). `--frozen` errors only when no lock exists or a project
is missing from it — it performs NO staleness checks of its own:
run `vx lock --check` first in the pipeline; that audit re-evaluates
everything, making any per-run re-check redundant.

## `vx lock`

Freeze every project's **resolved** config into `vx-lock.json` at the
workspace root. Configs are programs; `vx lock` evaluates them in the
current environment and stores the post-evaluation objects plus a
content hash of each config file.

```
vx lock              # Evaluate all vx.config.* now; write vx-lock.json.
vx lock --check      # Audit: hash checks + full re-evaluation vs the lock. Exit 1 on drift.
```

Plain runs ALWAYS evaluate live — the lock's existence changes
nothing. Only `vx run --frozen` consumes it: configs come from the
lock with no evaluation and no staleness checks of its own (frozen-env
semantics: env reads in a config keep their lock-time values; a
project absent from the lock or a missing lock is a hard error).

`--check` is the audit: it reports changed config files via the
stored hashes AND re-evaluates every config in the current
environment, `Bun.deepEquals`-comparing against the frozen objects —
catching eval-time env and import-closure drift that byte hashes
cannot see. The CI recipe is `vx lock --check && vx run … --frozen`.
Full design: `docs/design/config-lock-2026-06.md`.

Exit codes:

- `0` — lock written / lock is up to date.
- `1` — parse error, workspace-discovery error, missing lock
  (`--check` without one), or any drift (every mismatched project is
  listed on stderr).

## `vx migrate`

Generate one `vx.config.ts` per workspace package from an existing
Turbo or Nx setup. The source is auto-detected at the workspace root:

- `turbo.json` → **Turbo path**. Reads the root pipeline (`tasks` in
  turbo 2, `pipeline` in turbo 1), per-package `turbo.json` `extends`
  overlays (per-key merge over the root task), and each package's
  `package.json` scripts. A task is emitted for a package only when
  the package declares the matching script (turbo semantics); the
  script body is inlined as `exec.command`.
- `.nx/workspace-data/project-graph.json` → **Nx path**. Migrates
  from the resolved graph snapshot ONLY — plugin-inferred targets are
  frozen as static config (noted in the report header). When `nx.json`
  exists but the graph file is missing, the error tells you to run any
  nx command once (or `nx graph --file=.nx/workspace-data/project-graph.json`).
- Both present → error asking to delete the one you're not migrating
  from.

```
vx migrate           # write vx.config.ts files (and vx-preset.ts when needed)
vx migrate --dry     # print the generated file contents instead of writing
vx migrate --force   # overwrite existing vx.config.* / vx-preset.ts
```

Existing `vx.config.*` files are **never** overwritten without
`--force` — conflicts abort the whole run before anything is written.

Mapping highlights:

- **Turbo**: `dependsOn` copies verbatim (same micro-syntax);
  `inputs` → `cache.inputs.files` (`$TURBO_DEFAULT$` expands to
  `'**/*'` in place, `!` negation passes through); `outputs` →
  `cache.outputs.files` (vx outputs have no negation — negated
  entries become TODOs); `env` → `cache.inputs.env` AND
  `exec.env.passThrough` (vx child envs are isolated, so a hashed
  env var must also be forwarded); `passThroughEnv` → passThrough
  only; `cache: false` omits the cache block; `persistent: true` →
  `exec.persistent: {}` plus a TODO suggesting `readyWhen`.
  `globalEnv` / `globalPassThroughEnv` / `globalDependencies` become
  exported arrays in a generated root `vx-preset.ts` that each config
  imports and spreads — TypeScript composition replaces turbo's
  global fields. `$TURBO_ROOT$` forms are not representable → TODO.
- **Nx**: `nx:run-commands` joins `commands` with `' && '` (a `cwd`
  differing from the project root is a TODO); `nx:run-script` inlines
  the package.json script body; any other executor emits a valid
  placeholder command (`echo 'TODO(vx-migrate): fill in' && exit 1`)
  with a TODO carrying the executor + its options JSON. Inputs strip
  `{projectRoot}/`, expand named inputs from `nx.json`, route
  `{env: X}` to `cache.inputs.env` + passThrough, and TODO the rest
  (`{workspaceRoot}`, `^deps-inputs`, `externalDependencies`,
  `dependentTasksOutputFiles` — vx folds upstream via `dependsOn`
  already). Outputs strip `{projectRoot}/`, resolve literal
  `{options.x}` tokens, and append `/**` to bare directory paths.
  `dependsOn` objects map `projects: 'dependencies'` → `'^target'`,
  `'self'`/absent → `'target'`, project lists → `'proj#target'`.
  The graph's dependency edges are ignored (vx derives package edges
  from manifests); edges with no manifest counterpart produce one
  report line ("N implicit Nx deps not representable").

Everything unmappable becomes a `// TODO(vx-migrate): …` comment in
the generated file — TODOs are always comments, never values, so
every generated config loads and validates as-is. The run ends with a
report: tasks migrated clean, TODO count with `project#task: reason`
lines, and the files written.

Exit codes: `0` success (TODOs don't fail the run); `1` parse error,
detection error, or overwrite conflict without `--force`.

## `vx show`

Introspect the workspace's **live resolved configs** — what a run
would see right now. Configs are evaluated with the same loader the
run path uses; `vx show` never reads `vx-lock.json` (the lock is
already the frozen JSON — open it directly if you want the frozen
view).

```
vx show                          # list every project
vx show <project>                # one project's resolved config
vx show <pkg>#<task>             # a single task
vx show ... --format json        # machine-readable (default: pretty)
```

No target: one line per project — name, root-relative dir, declared
task count, and a `(no vx config)` marker for config-less packages.
With `--format json` it's an array of `{ name, dir, tasks: string[] }`.

```
$ vx show
app   packages/app   3 tasks
bare  packages/bare  (no vx config)
```

`vx show <project>` prints a block per task: description, command
(`(group)` for group tasks), `dependsOn`, `cache.inputs.files` /
`.env` / `.tasks`, `cache.outputs.files`, and persistent fields.
`--format json` emits `{ name, dir, config }` with the config exactly
as resolved. `vx show <pkg>#<task>` narrows to one task
(`{ name, dir, task, config }` in JSON).

```
$ vx show app#build
app — packages/app

build
  description:   compile the app
  command:       tsc -b
  dependsOn:     ^build
  inputs.files:  src/**
  inputs.env:    NODE_ENV
  outputs.files: dist/**
```

Unknown project / task names exit `1` with includes-match suggestions
(`unknown project: "ap" — did you mean app?`).

Exit codes: `0` success; `1` parse error or unknown target.

## `vx info`

Workspace doctor — one screen of facts for bug reports and sanity
checks (pretty only):

```
$ vx info
vx:             0.0.0
bun:            1.3.14
git:            2.53.0
workspace root: /work/repo
projects:       12 (34 tasks)
cache dir:      /work/repo/.vx/cache
cache entries:  42 (1.3 GB)
runs (24h):     7 (5 cache hits)
vx-lock.json:   yes
remote cache:   no
```

- `git` shows `(not found)` when the binary is missing; a broken
  project config contributes zero tasks instead of failing the
  printout.
- `remote cache` is `yes` when both `VX_REMOTE_CACHE_URL` and
  `VX_REMOTE_CACHE_TOKEN` are set.
- `vx stats` is a **deprecated alias** of `vx info` (info absorbed
  it); it prints byte-identical output.

## Output format

`vx run` emits Turbo-style framed blocks. Stdout/stderr from each
task is buffered until completion, then dumped inside the block — so
concurrent tasks never interleave their lines.

```
• vx 0.0.0

   • Packages in scope: @vzn/vx
   • Running ci in 1 package
   • Remote caching disabled

┌─ @vzn/vx#format-check > cache hit • 02bfe8a9
└─ @vzn/vx#format-check ── (3ms) from local cache

┌─ @vzn/vx#lint > cache hit • d66cfed2
Found 0 warnings and 0 errors.
└─ @vzn/vx#lint ── (4ms) from local cache

┌─ @vzn/vx#test > executed
$ bun test
... test output ...
└─ @vzn/vx#test ── (5.20s) executed

 Tasks:    3 successful, 3 total
Cached:    2 local, 3 total
  Time:    5.34s
>>> FULL CACHE
```

Group tasks emit no framed block by design (they aren't real tasks).
`>>> FULL CACHE` appears when every executable task in the run was
served from cache.

### Colors

ANSI truecolor (`ansi-16m`) sequences, gated by env:

| Var             | Effect                              |
| --------------- | ----------------------------------- |
| `NO_COLOR=…`    | Force off. Overrides `FORCE_COLOR`. |
| `FORCE_COLOR=…` | Force on.                           |
| (neither)       | On iff `stdout.isTTY`.              |

Programmatic callers passing a custom `log` to the run options always
see plain text.

## Remote cache (env-driven)

If `VX_REMOTE_CACHE_URL` and `VX_REMOTE_CACHE_TOKEN` are set in the
environment, `vx run` layers a remote cache on top of the local one.

Reads try local first, then remote (hydrating local on remote hit).
Writes go to local immediately, then upload to remote in the
background — failures are logged via `onRemoteError` but do not
fail the user's build.

| Env var                         | Required? | Notes                                                                                                                                                                      |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VX_REMOTE_CACHE_URL`           | yes       | Base URL, e.g. `https://cache.example.com`.                                                                                                                                |
| `VX_REMOTE_CACHE_TOKEN`         | yes       | Bearer token sent on every request.                                                                                                                                        |
| `VX_REMOTE_CACHE_TEAM_ID`       | no        | Sent as `?teamId=` (Turbo tenancy).                                                                                                                                        |
| `VX_REMOTE_CACHE_SLUG`          | no        | Sent as `?slug=`.                                                                                                                                                          |
| `VX_REMOTE_CACHE_TIMEOUT_MS`    | no        | Per-request timeout. Default `60000`.                                                                                                                                      |
| `VX_REMOTE_CACHE_SIGNATURE_KEY` | no        | HMAC artifact signing (Turbo-compatible `x-artifact-tag`). When set, uploads are signed and downloads are verified — a missing or mismatched tag degrades to a cache miss. |

Wire spec is Turborepo `/v8/artifacts/`. Compatible servers include
`ducktors/turborepo-remote-cache`, `Fox32/openturbo-remote-cache`, and
Vercel's hosted Turbo cache. See
[`design/remote-cache.md`](./design/remote-cache.md) for the full
protocol.

## Run analytics

`vx info` surfaces the aggregate cache stats (entry count, total
size, runs + hits in the last 24 h). For anything deeper, vx records
every task to a `runs` table in `cache.db` — ULID
`run_id`, hrtime wallclock spans, cpu_ms, peak RSS, status, cache_hit
flag, bytes_uploaded / \_downloaded for the remote layer. The
SQLite file IS the API:

```sh
sqlite3 .vx/cache/cache.db "
  SELECT project, task, status, duration_ms
  FROM runs
  WHERE run_id = (SELECT run_id FROM runs ORDER BY id DESC LIMIT 1)
  ORDER BY duration_ms DESC;
"
```

The schema is documented in
[`caching.md` § SQLite tables](./caching.md#sqlite-tables).

## What's still missing vs Turbo

Tracked in detail in [`comparison.md`](./comparison.md). Recap of the
gaps visible from the CLI:

- `--continue=<mode>` (current behavior: independent siblings continue;
  dependents are skipped).
- `--output-logs full|errors-only|hash-only|none`.
- `--cache-dir <path>` CLI flag (workspace-config field works; CLI flag
  doesn't).
- `--remote-cache-timeout`, `--token`, `--team` on the CLI (env vars
  work).
- `vx prune` (workspace subset for Docker builds).

## Programmatic API

```ts
import { run, planRun, defineProject, defineWorkspace } from '@vzn/vx'

const summary = await run({
  cwd: process.cwd(),
  tasks: ['build', 'test'],
  concurrency: 4,
  noCache: false,
})
// summary.ok: boolean; summary.outcomes: TaskOutcome[]

const plan = await planRun({
  cwd: process.cwd(),
  tasks: ['build'],
})
// plan.tasks: PlannedTask[]
```

Surface:

- `run(options)` — execute. Returns `Promise<RunSummary>`.
- `planRun(options)` — predict, no execute. Returns
  `Promise<RunPlan>`. Used by `--dry` / `--graph`.
- `defineProject` / `defineWorkspace` — identity helpers for type
  inference in user configs.
- `RunOptions` / `RunSummary` / `RunPlan` / `TaskOutcome` types are
  re-exported from `@vzn/vx`.

A `log: Logger` option lets embedders swap the default framed-block
logger for a custom one (e.g. JSON-line emission). Custom loggers
always see plain text (colors are off when a non-default logger is
provided).

The CLI dispatcher (`run(argv)` in `src/cli.ts`) is not part of the
public package exports yet; `bin.ts` calls it directly.
