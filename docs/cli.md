# CLI reference

The `vx` binary is installed by `@vzn/vx`. All commands are
hand-parsed (no commander/yargs/etc.) in `src/cli.ts`; each subcommand
handler lives in `src/cli/<name>.ts`.

The flag surface is aligned with [Turborepo's `turbo run`](https://turborepo.com/docs/reference/run)
so existing Turbo users can swap in with minimal muscle-memory churn.

## Commands

```
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx cache prune [--older-than <duration>] [--max-size <bytes>]
vx help
vx version
vx --help, -h
vx --version
```

Multiple positional tasks run in one orchestrator invocation with a
shared task graph: `vx run build lint test` fans out all three across
the resolved project scope. Anchored entries (`pkg#task`) target a
specific project; bare entries follow the usual scope rules
(default = cwd project; `--all` / `--filter` to broaden).

(No `-V` for version; `vx --version` only — matches Turbo.)

## `vx run [TASK]`

Run the named task. By default only the project containing the current
working directory is selected — `dependsOn` still expands so the
project's upstream workspace deps run too. Override the selection with
`--all`, `--filter`, or `pkg#task`.

If no task name is given:

- In a TTY: an interactive picker lists every `pkg#task` entry across
  the workspace, prompts for a number, runs the chosen one.
- Not a TTY: the run exits `1` with `missing task name`.

Exit codes:

- `0` — every task finished `success` or `cache-hit`.
- `1` — at least one task ended `failed` or `skipped`.

### Selection

| Form       | Effect                                                                |
| ---------- | --------------------------------------------------------------------- |
| (default)  | The project that contains cwd. Errors if cwd is not inside a project. |
| `pkg#task` | Just that project.                                                    |
| `--all`    | Every project that declares the task.                                 |
| `--filter` | pnpm-style filter DSL (repeatable).                                   |

### Filter DSL (`--filter`)

| Form            | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `<pattern>`     | Match by package name. `*` is a wildcard (no `/`).                            |
| `./<dir>`       | Match packages whose dir is at or under `<dir>` (relative to workspace root). |
| `{<dir>}`       | Same as `./<dir>`.                                                            |
| `<pattern>...`  | Match + all transitive workspace dependencies.                                |
| `...<pattern>`  | Match + all transitive workspace dependents.                                  |
| `<pattern>^...` | Only the transitive dependencies, excluding the matched package itself.       |
| `!<pattern>`    | Exclude packages matching `<pattern>`.                                        |

Examples:

```sh
vx run build --filter @scope/*        # all packages under @scope
vx run build --filter app...          # app and its transitive deps
vx run build --filter ...util         # util and everything that depends on it
vx run build --filter app^...         # only app's deps
vx run build --filter '*' --filter '!docs'  # everything except docs
```

### Argument forwarding (`--`)

Anything after `--` is forwarded (shell-quoted) to the task's `exec.command`:

```sh
vx run test -- --watch              # underlying test runner sees --watch
vx run build -- --sourcemap         # build command gets --sourcemap
```

Forwarded args are folded into the cache key — different args produce
different cache entries.

### Flags

| Flag                              | Type           | Default                         | Description                                                                                                         |
| --------------------------------- | -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--filter`, `--filter`            | repeatable     | (none)                          | pnpm-style filter DSL (see above).                                                                                  |
| `--all`                           | boolean        | off                             | Select every project that declares the task.                                                                        |
| `--excludeDependencies[=<names>]` | optional value | off                             | Drop `dependsOn` edges. No value = all (just the requested task runs); comma-list = drop only those specific names. |
| `--concurrency <n>`               | positive int   | `navigator.hardwareConcurrency` | Maximum parallel tasks. `1` serializes.                                                                             |
| `--no-cache`, `--force`           | boolean        | off                             | Skip cache reads AND writes; outputs are NOT cleaned.                                                               |
| `--cache`                         | boolean        | off                             | No-op (parity with vite-task).                                                                                      |
| `--verbosity <n>`                 | int (0+)       | `0`                             | `1` prints a per-task summary table after the framed blocks; `2+` reserved.                                         |
| `--dry[=text\|json]`              | optional value | off                             | Print the task graph + predicted cache hit/miss; skip execution.                                                    |
| `--graph[=<path>]`                | optional value | off                             | Emit Graphviz DOT (stdout if no path); skip execution. Format from extension.                                       |
| `--summarize[=<path>]`            | optional value | off                             | Write per-run JSON to `<cacheDir>/runs/<run_id>.json` (or the explicit path).                                       |
| `--profile[=<path>]`              | optional value | off (`profile.json` when set)   | Write Chrome-trace JSON of the run's wallclock spans (open in chrome://tracing).                                    |

Mutually exclusive:

- `--dry` and `--graph` — both skip execution; pick one form.
- `--dry` or `--graph` with `--summarize` or `--profile` — the latter
  two need a real run.

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
| `◉`    | cache hit (local) — entry already in `.vx/cache/`            |
| `↓`    | cache hit (remote) — entry would be fetched from the layer   |
| `▶`    | cache miss — task would execute                              |
| `·`    | no-cache — task opts out (no `cache` block, or `--no-cache`) |
| `○`    | group task (suppressed in human view; in DOT + JSON)         |

`--dry=json` emits the same data as a JSON object:

```json
{
  "tasks": [
    {
      "id": "@vzn/vx#lint",
      "project": "@vzn/vx",
      "task": "lint",
      "hash": "d66cfed2...",
      "cacheStatus": "hit-local",
      "deps": []
    }
  ]
}
```

`--graph` prints Graphviz DOT (stdout by default; pass `--graph=path`
to write a file). Pipe through `dot` to render:

```
vx run ci --graph | dot -Tsvg > graph.svg
vx run ci --graph=graph.dot
```

Node fillcolor varies by predicted status (green = local hit, sky-blue
= remote hit, orange = miss, gray = no-cache, fuchsia = group).

## Run artifacts (`--summarize`, `--profile`)

Both flags add a side-effect after a real run completes.

`--summarize[=<path>]` writes a per-run JSON file:

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
strings (BigInt) to preserve ns precision through JSON.

`--profile[=<path>]` writes a Chrome-trace JSON of the run's wallclock
spans. Default path: `profile.json` (cwd-relative). Open with
`chrome://tracing` or https://ui.perfetto.dev.

Each task is one complete event (`ph: "X"`) with `ts` and `dur` in
microseconds derived from the `hrtime.bigint()` spans the runner
captures per task. Each project gets its own `tid` so concurrent
tasks render on distinct lanes — perfect for spotting serial
bottlenecks vs true parallelism in a monorepo. The `args` object
carries the exit code, content-addressed cache `hash`, and (where
the runner captured them) `cpuMs` + `peakRssBytes` from rusage.
`cat` is the task's final status (`success`, `cache-hit`,
`cache-hit-remote`, `failed`).

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

Each project gets a distinct `tid` so concurrent tasks render on
separate lanes.

## `vx cache prune`

Evict old or oversized cache entries. Operates on `.vx/cache/cache.db`
plus the on-disk `<hash>/` directories and `logs/<hash>.{stdout,stderr}`
files.

```
vx cache prune --older-than <duration>     Drop entries last accessed before now - duration.
vx cache prune --max-size <size>           After age-based pruning, evict LRU until under <size>.
```

At least one of `--older-than` / `--max-size` is required. Both may be
combined: age-based first, then LRU-evict if still over the size cap.

**Duration units**: `s`, `m`, `h`, `d`. Examples: `30d`, `24h`, `60m`, `30s`.
**Size units**: `K`, `M`, `G`, `T` (powers of 1024). Optional `B` suffix
accepted. Examples: `500M`, `1G`, `100K`, `2T`, `500MB`.

```
$ vx cache prune --older-than 30d
Pruned 42 entries (1.3 GB freed)
```

Exits `1` on parse error, missing policy, or workspace-discovery error.

## Output format

`vx run` emits Turbo-style framed blocks. Stdout/stderr from each task
is buffered until completion, then dumped inside the block — so
concurrent tasks never interleave their lines.

```
• vx 0.0.0

   • Packages in scope: @vzn/vx
   • Running ci in 1 package
   • Remote caching disabled

┌─ @vzn/vx#lint > cache hit • 7da42dfe
Found 0 warnings and 0 errors.
└─ @vzn/vx#lint ── (4ms) from local cache

┌─ @vzn/vx#test > executed
$ bun test
... test output ...
└─ @vzn/vx#test ── (5.20s) executed

 Tasks:    2 successful, 2 total
Cached:    1 local, 2 total
  Time:    5.34s
```

Group tasks emit no framed block by design.

### Colors

ANSI truecolor (`ansi-16m`) sequences, gated by env:

| Var             | Effect                        |
| --------------- | ----------------------------- |
| `NO_COLOR=…`    | Force off. Overrides FORCE\_. |
| `FORCE_COLOR=…` | Force on.                     |
| (neither)       | On iff `stdout.isTTY`.        |

Custom loggers passed via the programmatic API always see plain text.

## Remote cache (env-driven)

If `VX_REMOTE_CACHE_URL` and `VX_REMOTE_CACHE_TOKEN` are set in the
environment, `vx run` layers a remote cache on top of the local one.
Reads try local first then remote (hydrating local on remote hit);
writes go to local immediately, then upload to remote in the background
(failures are logged, not fatal).

| Env var                      | Required? | Notes                                       |
| ---------------------------- | --------- | ------------------------------------------- |
| `VX_REMOTE_CACHE_URL`        | yes       | Base URL, e.g. `https://cache.example.com`. |
| `VX_REMOTE_CACHE_TOKEN`      | yes       | Bearer token sent on every request.         |
| `VX_REMOTE_CACHE_TEAM_ID`    | no        | Sent as `?teamId=` (Turbo tenancy).         |
| `VX_REMOTE_CACHE_SLUG`       | no        | Sent as `?slug=`.                           |
| `VX_REMOTE_CACHE_TIMEOUT_MS` | no        | Per-request timeout. Default `60000`.       |

Wire spec is Turborepo `/v8/artifacts/`. Compatible servers include
`ducktors/turborepo-remote-cache`, `Fox32/openturbo-remote-cache`, and
Vercel's hosted Turbo cache. See `docs/design/remote-cache.md` for the
full protocol.

## What's still missing vs Turbo

Tracked in [`comparison.md`](./comparison.md). Highlights:

- `--affected` / `[<since>]` filter syntax (git-relative selection)
- `vx watch` subcommand
- `--continue` (current behavior: independent siblings continue, dependents are skipped)
- `--output-logs full|errors-only|hash-only|none`
- `--cache-dir <path>` (workspace-config field works; CLI flag doesn't)
- `--remote-cache-timeout`, `--token`, `--team` on CLI (env vars work)

## Internal API

```ts
import { run as cliRun } from '@vzn/vx/cli' // not yet re-exported
import { run, planRun } from '@vzn/vx'
```

`run(argv)` is the CLI dispatcher; `run(options)` and `planRun(options)`
are the programmatic orchestrator entry points. The CLI dispatcher is
not part of the public package exports yet; the `bin.ts` entry calls it
directly.
