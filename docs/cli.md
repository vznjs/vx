# CLI reference

The `vx` binary is the user-facing entry point. The implementation is
intentionally simple: a hand-rolled argv parser (no commander / yargs)
in `src/cli/index.ts` dispatches to per-subcommand handlers under
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
# Core
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx watch [OPTIONS] TASK [-- forwarded-args...]
vx cache prune [--older-than <duration>] [--max-size <bytes>]
vx lock [--check]
vx migrate [--from turbo|nx] [--dry] [--force]
vx show [PROJECT[#TASK]] [--format pretty|json]
vx info
vx stats              # deprecated alias of vx info
vx upgrade [tag]      # self-update a compiled binary
vx mcp [--stdio]      # MCP server for AI agents

# Cloud — the @vzn/vx-cloud package (separately installed; the `vx-cloud` binary)
vx-cloud serve [--port N] [--ingest-dir D] [--token T] [--name N] [--ui] [--open]
vx-cloud connect <url> [--name N] [--token T] [--delegate] [--no-use] [--force]
vx-cloud env ls | use <name> | rm <name>
vx-cloud disconnect
vx-cloud agent --url <serve> [--token T] [--capacity N] [--session S] [--idle-timeout MS] [--label L]
vx-cloud dev

# Meta
vx help
vx --help, -h
vx version
vx --version
```

Typing `vx serve` / `dev` / `coordinator` / `worker` prints a
redirect: those commands moved to `@vzn/vx-cloud` in the core/cloud
split — core has no service CLI. Within `vx-cloud`, the `coordinator`
and `worker` verbs are RETIRED (distributed-execution-2026-07):
`coordinator` was absorbed into `vx-cloud serve` (enable with
`VX_CLOUD_DISTRIBUTE=<n>` on the submitting run), and `worker` is now
`vx-cloud agent`; both print redirects.

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
`vx-lock.json` is filtered out of the changed set — a `vx lock`
re-write never marks every project affected.

### Argument forwarding (`--`)

Anything after `--` is forwarded (shell-quoted) to the task's
`exec.command`:

```sh
vx run test -- --watch              # underlying test runner sees "--watch"
vx run build -- --sourcemap         # build command gets "--sourcemap"
```

Forwarded args are folded into the cache key — different args produce
different cache entries. They scope to user-requested tasks only;
dependsOn-pulled deps don't see them (so upstream cache identity
stays clean).

### Flags

| Flag                              | Type           | Default                         | Description                                                                                                                                       |
| --------------------------------- | -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--filter <pattern>`              | repeatable     | (none)                          | pnpm-style filter DSL (see above).                                                                                                                |
| `--all`                           | boolean        | off                             | Select every project that declares the task.                                                                                                      |
| `--affected[=<base>]`             | optional value | off                             | Filter to projects changed since `<base>` (default `origin/HEAD`).                                                                                |
| `--excludeDependencies[=<names>]` | optional value | off                             | Drop `dependsOn` edges. No value = all (just the requested task runs); comma-list = drop only those names.                                        |
| `--concurrency <n>`               | positive int   | `navigator.hardwareConcurrency` | Maximum parallel tasks. `1` serializes.                                                                                                           |
| `--no-cache`                      | boolean        | off                             | Disable caching entirely (no reads, no writes); output globs are NOT cleaned.                                                                     |
| `--force`                         | boolean        | off                             | Re-execute everything (skip cache reads) but still REFRESH the cache (writes stay on). Output globs are cleaned (so the saved snapshot is clean). |
| `--cache <spec>`                  | value          | all axes on                     | Per-layer read/write control. See below.                                                                                                          |
| `--frozen`                        | boolean        | off                             | Load configs from `vx-lock.json` instead of evaluating (CI). See § `--frozen`.                                                                    |
| `--output-logs <mode>`            | value          | flow-derived                    | `full` \| `errors-only` \| `none` — explicit output override. See § `--output-logs`.                                                              |
| `--verbosity <n>`                 | int (0+)       | `0`                             | `1` prints a per-task summary table after the framed blocks; `2+` reserved.                                                                       |
| `--dry[=text\|json]`              | optional value | off                             | Print the task graph + predicted cache hit/miss; skip execution.                                                                                  |
| `--graph[=<path>]`                | optional value | off                             | Emit Graphviz DOT (stdout if no path); skip execution.                                                                                            |
| `--summarize[=<path>]`            | optional value | off                             | Write per-run JSON to `<cacheDir>/runs/<run_id>.json` (or the explicit path).                                                                     |
| `--profile[=<path>]`              | optional value | off (`profile.json` when set)   | Write Chrome-trace JSON of the run's wallclock spans.                                                                                             |
| `--tag <k=v>`                     | repeatable     | (none)                          | Label this invocation. Recorded on the run's `invocations` row so dashboards can filter runs. `--tag=k=v` form too.                               |
| `--report[=markdown]`             | optional value | off                             | After the run, print a markdown run report to stdout. Only `markdown` is supported (`json` is reserved).                                          |

Mutual exclusion:

- `--dry` and `--graph` — both skip execution; pick one.
- `--dry` or `--graph` with `--summarize` or `--profile` — the latter
  two need a real run.

Unknown flags are a parse error (`unknown flag: --foo`).

#### Cache control: `--cache`, `--no-cache`, `--force`

The cache has four independent axes — **localRead**, **localWrite**,
**remoteRead**, **remoteWrite** — and the three flags above resolve
them in this precedence order:

1. Start with every axis **on** (the default).
2. Apply each `--cache=<spec>` segment (the base).
3. If `--no-cache` was passed, force **all four off**.
4. If `--force` was passed, force **both reads off** (writes stay
   whatever the base / `--cache` left them).

So `--no-cache` always wins over `--force`. The common cases:

- `--no-cache` → nothing reads, nothing writes, and declared output
  globs are left untouched (you're debugging; vx won't manage your
  tree).
- `--force` → re-execute every task (reads off) but still write fresh
  artifacts to both layers (writes on). Output globs ARE cleaned
  before each task so the saved snapshot is clean. This is the "rebuild
  and refresh the cache" flag.

`--cache=<spec>` is a comma-separated list of `<layer>:<flags>`
segments. `layer` is `local` or `remote`; `flags` is any subset of `r`
(read) and `w` (write), order-independent and possibly empty. A
**mentioned** layer is set EXACTLY to its flags; an **unmentioned**
layer keeps its current value. Both `--cache=<spec>` and the space form
`--cache <spec>` are accepted.

| Spec                        | Effect                                                  |
| --------------------------- | ------------------------------------------------------- |
| `--cache=local:rw,remote:r` | remote read-only (won't upload); local full             |
| `--cache=local:r`           | local read-only; remote untouched (still full)          |
| `--cache=remote:`           | remote fully off; local untouched                       |
| `--cache=local:,remote:rw`  | don't touch the local cache, but still upload to remote |

Combine with `--force` for "re-execute and refresh only the remote":
`--cache=local: --force` (local off, reads off, remote write-only).

Invalid layers/flags are a parse error
(`invalid --cache layer 'disk'`, `invalid --cache flag 'x'`, …).

### Output

What a run prints is derived from the run's intent (its "flow"),
unless explicitly overridden:

- **FOCUSED** — no selection flag was passed. The user is running
  "their" task; cwd and task count are irrelevant to the
  classification.
- **BROAD** — the invocation used `--all`, `--filter`, or
  `--affected`. The user asked about a swath of the workspace and
  wants news, not output.
- **CI** — the `CI` env var is truthy (`CI=0` / `CI=false` don't
  count). Wins over the flow.

Reported task lines share one column grid —
`<glyph> <time> <status> <cache> <name>` — with two orthogonal axes:
the glyph SHAPE encodes the cache axis, the glyph COLOR (and the
status word) the task axis.

| Glyph | Cache axis                | Status word    |
| ----- | ------------------------- | -------------- |
| `⏺`   | miss — the task ran       | success/failed |
| `►`   | fresh (up-to-date)        | success        |
| `⇢`   | restored from local cache | success        |
| `⇣`   | restored from remote      | success        |
| `◼`   | failed                    | failed         |
| `⊘`   | skipped (upstream failed) | skipped        |
| `⦿`   | running (worker row)      | running        |
| `▸`   | persistent (dev server)   | running        |

Per-task visibility by outcome:

| Outcome                | focused (requested task)    | focused (dependency)      | broad                     | CI / `full`                  |
| ---------------------- | --------------------------- | ------------------------- | ------------------------- | ---------------------------- |
| executed               | raw output, streamed live   | silent                    | grid one-liner            | frame                        |
| restored-local/-remote | replayed stdout, streamed   | silent                    | silent                    | frame, or one-liner if quiet |
| up-to-date             | one-liner (nothing to show) | silent                    | silent                    | one-liner                    |
| failed                 | raw output, streamed live   | one-liner + frame replays | one-liner + frame replays | frame                        |
| skipped                | frame                       | silent                    | silent                    | frame                        |

When a dependency fails mid-run, the stream gets ONE permanent
`◼ … failed miss <id>` line and the run continues; **all full failure
frames replay together at run end**, right above the summary, so
failures read last and are never capped.

The end-of-run summary always prints; cache-hit counts that broad
mode silences per-task surface there. A focused `vx run test` is meant
to feel like running the test command directly — same output, just
faster.

**Groups are transparent folders.** A group task (no `exec`, just
`dependsOn`) has no output of its own, so running one focused —
`vx run build` where `build` chains `build.bun` which chains
`build.bun.darwin-arm64` … — surfaces the **real tasks** it stands for
and shows them like requested tasks. The walk descends through nested
groups but never leaves the requested project (`^`/cross-project deps
aren't surfaced) and never goes past a real task into its own deps.
The requested count for the live-vs-buffered decision counts the
surfaced tasks: one real task streams live, several buffer into atomic
blocks. (Surfacing is display-only — it does not make those tasks
"requested", so `--` `forwardArgs` still go only to what you named.)

Live streaming applies only when there is exactly **one** requested
task. Live open/close framing assumes a single task owns the terminal
between its open (`┌─`) and close (`└─`) lines — with two requested
tasks running concurrently their frames would interleave into garbage.
So when more than one task is requested (`vx run build test`), each
requested task instead **buffers** its output and renders as a single
atomic block at completion (success/failure/cache-hit-with-replay get
a full frame, up-to-date/skipped get a one-liner). The blocks are
blank-line separated and never interleave. A single `vx run test`
keeps the live-stream experience unchanged.

On an interactive terminal (TTY stdout, not CI) a status region
tracks the run live. Top to bottom:

1. **A blank separator line** — keeps the live region visually apart
   from the completed-task scrollback above it.
2. **Pinned persistent tasks** — `▸ <id> running` for every persistent
   task that became ready. The pin lives until run end, so it is the
   visible evidence the dev server is still alive.
3. **Worker rows** — one per worker slot (sized
   `min(concurrency, 10)`), no glyph and no spinner: the live ticking
   elapsed time leads (`     568ms running  <id>`). A task stays in
   its row for its whole life; idle rows hold their place dimmed, so
   nothing ever jumps; overflow shows as `+k more`.
4. **The live summary section** — the SAME meters the final footer
   prints (`tasks` + `cache` bars with legends, `time`), filling in as
   the run progresses, under a bare `vx` wordmark rule.

The region is redrawn in place (cursor-up + clear; not a TUI — no
alternate screen) and erased before the final summary prints. In the
focused flow it only lives while dependencies run; it disappears for
good the moment the requested task starts streaming.

Redraw cost is bounded: task events force a redraw, but forced
redraws within 30 ms of the last draw coalesce into a single
trailing draw when the floor expires (the final state always lands).
On a 3,270-task warm run this cuts ~6.7 MB of redraw ANSI to ~20 KB.

Identity coloring: every `project#task` renders its project half in
a stable hue hashed from the project name (same project = same color
in every run and every surface) and its task half in a fixed pink —
both deliberately outside the status palette, so an id can never
read as an outcome.

On GitHub Actions (`GITHUB_ACTIONS` truthy, full output mode), each
task's block is wrapped in `::group::<id> (<outcome> <duration>)` /
`::endgroup::` so it collapses in the log viewer. Failed tasks stay
pre-expanded and emit an `::error title=<id>::failed (exit N)`
annotation instead.

### `--output-logs <mode>`

Explicit override; always beats the flow and CI defaults. `full`
(frames for executed work, one-liners for quiet cache hits),
`errors-only` (only failed tasks print; the CI noise budget), `none`
(no per-task output). The end-of-run summary always prints.

## Planning mode (`--dry`, `--graph`)

Both flags short-circuit execution. They build the full task graph,
compute every task's cache key, and probe the cache to predict the
hit/miss outcome. Against a remote cache the probe is a lightweight
existence check — planning never downloads or ingests artifacts.

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

### `--report[=markdown]`

After a real run completes, prints a markdown run report to **stdout**
(not the status logger — it stays machine-clean). One header line of
totals plus a table, one row per task:

```markdown
## vx run — passed

**3 tasks** · 3 success · 0 failed · 2 cached · 1.23s total · 8ms saved

| Task      | Status  | Cache      | Duration |
| --------- | ------- | ---------- | -------- |
| web#build | success | miss       | 1.23s    |
| web#test  | success | local      | 5ms      |
| api#test  | success | up-to-date | 3ms      |
```

`Status` is the task outcome (`success` / `failed (exit N)` / `skipped`);
`Cache` is its provenance (`miss` / `local` / `remote` / `up-to-date` /
`—`). Aborted tasks (a Ctrl-C teardown) are excluded.

Only `markdown` is supported today (`json` is reserved; a bad value is a
parse error). Built purely from the run's outcomes after it returns — it
adds zero cost when the flag is absent. The intended use is CI step
summaries:

```sh
vx run ci --report=markdown >> "$GITHUB_STEP_SUMMARY"
```

### `--tag <k=v>`

Labels the invocation. Repeatable; `--tag=k=v` form too. The pair is
split on the **first** `=`, so values may contain `=` (e.g. a URL). An
empty key is a parse error. Tags are recorded on the run's
`invocations` row so dashboards can filter runs by label.

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
   changes. When any project's config declares
   `cache.inputs.workspaceFiles`, the per-project watchers are swapped
   for ONE recursive root watcher (boundaries are off for those globs,
   so any workspace file can be an input).
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
`<cacheDir>/cache.db` plus the on-disk `<hash>.tar.zst` artifacts.

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

`vx cache prune` resolves the workspace root from cwd and honors a
`defineWorkspace({ cacheDir })` override — it prunes the same
directory a run would use.

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

## `vx upgrade`

Self-update the compiled binary in place: downloads the release asset
for this platform and atomically replaces the running executable
(`vx upgrade <tag>` pins a specific release; default latest). Named
`upgrade` per CLI convention (`bun upgrade`, `deno upgrade`). Refuses
when running from source — use `git pull`. Re-running `install.sh`
remains equivalent.

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
- Both present → pass `--from turbo` or `--from nx` to disambiguate
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
  global fields (`globalDependencies` spread into
  `cache.inputs.workspaceFiles`: they are root-relative by
  definition). `$TURBO_ROOT$/<path>` inputs map to
  `cache.inputs.workspaceFiles` (negation keeps `!`), outputs to
  `cache.outputs.workspaceFiles`; `$TURBO_ROOT$` in `dependsOn` (and
  non-prefix forms) stays a TODO — vx has no workspace-root tasks.
- **Nx**: `nx:run-commands` joins `commands` with `' && '` (a `cwd`
  differing from the project root is a TODO); `nx:run-script` inlines
  the package.json script body; any other executor emits a valid
  placeholder command (`echo 'TODO(vx-migrate): fill in' && exit 1`)
  with a TODO carrying the executor + its options JSON. Inputs strip
  `{projectRoot}/`, map `{workspaceRoot}/<path>` to
  `cache.inputs.workspaceFiles` (negation keeps `!`), expand named
  inputs from `nx.json`, route `{env: X}` to `cache.inputs.env` +
  passThrough, and TODO the rest (`^deps-inputs`,
  `externalDependencies`, `dependentTasksOutputFiles` — vx folds
  upstream via `dependsOn` already). Outputs strip `{projectRoot}/`,
  map `{workspaceRoot}/<path>` to `cache.outputs.workspaceFiles`,
  resolve literal `{options.x}` tokens, and append `/**` to bare
  directory paths.
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

## `vx mcp` — Model Context Protocol server

Boot an MCP server so AI coding agents (Claude Code, Cursor,
Continue.dev, VS Code GitHub Copilot, …) can query vx state through
the standard agent-tool protocol. Stdio transport only.

```
vx mcp                           # stdio transport (default)
vx mcp --stdio                   # explicit
```

Add to an MCP client config (Claude Code example):

```jsonc
// ~/.claude/mcp.json
{
  "mcpServers": {
    "vx": { "command": "vx", "args": ["mcp"] },
  },
}
```

Tools exposed:

| Tool              | Purpose                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `getCacheStats`   | Aggregate cache stats (entries, total size, runs/hits last 24h, hit rate)                                                   |
| `getRunHistory`   | Recent runs filtered by `project` / `task` / `limit`, with per-pair p50/p99/successRate/hitRate aggregates                  |
| `explainCacheKey` | Persisted entry metadata for a `project#task` (hash, command, exit code, duration, size, created_at)                        |
| `whyDidThisRerun` | Compares a `(runId, taskId)` against the immediately preceding run for the same task; reports whether the cache key changed |

All tools read the local `cache.db` opened on demand. No network, no
auth (stdio is process-private). Future tools (`runTasks`,
`getRunState`) ship under the `vx:rpc` channel when the inspector WS
surface lands.

# Cloud commands — the `@vzn/vx-cloud` package

The service layer (`serve` / `connect` / `env` / `coordinator` /
`worker` / `dev`, the `/v1/*` metrics API, the bundled dashboard)
lives in a **separate package, `@vzn/vx-cloud`**, which ships its own
`vx-cloud` binary. Core `vx` stays limited to discovery / graph /
cache / exec / the in-process run. Install it alongside core to get
the commands below:

```
bun add -D @vzn/vx-cloud        # or run it from the package's vx-cloud bin
```

Core integrates with cloud through the first-party `cloud()` plugin —
declare it in `vx.workspace.ts`
(`defineWorkspace({ plugins: [cloud()] })`) and every `vx run` pushes
its run summary to the chosen server, can delegate execution to a
service, and can layer the cloud cache. Anyone can write a different
plugin against the same `VxPlugin` interface. This section is a
summary; the cloud package's own README (`packages/cloud/`) is the
depth reference.

## `vx-cloud serve` — standalone dashboard + ingest service

One foreground process: SQLite ingest store + `/v1/*` metrics JSON
API + SSE/NDJSON event streams + WS run delegation + the embedded
dashboard SPA. Runs locally or in Docker (see
`packages/cloud/deploy/`).

```
vx-cloud serve
    --port <n>                   # default: VX_CLOUD_PORT, else 4321
    --host <h>                   # bind address (env: VX_CLOUD_HOST); default 127.0.0.1.
                                 #   a non-loopback bind REQUIRES a token
    --ingest-dir <d>             # directory for the SQLite ingest store
    --token <t>                  # the TRUSTED bearer token (env: VX_CLOUD_TOKEN)
    --pr-token <t>               # the UNTRUSTED (fork-PR) token (env: VX_CLOUD_PR_TOKEN):
                                 #   reads trusted+untrusted, writes only untrusted
    --allow-origin <o>           # extra browser origin allowed on the WS/SSE channels
                                 #   (repeatable; env: VX_CLOUD_ALLOW_ORIGIN, comma-sep)
    --name <n>                   # server identity for /v1/meta (env: VX_CLOUD_NAME)
    --socket [path]              # also listen on a unix socket (env: VX_CLOUD_SOCKET;
                                 #   default $XDG_RUNTIME_DIR/vx-cloud/serve.sock)
    --ui                         # require the bundled SPA (error if not built)
    --open                       # open the dashboard in the browser (implies --ui)
```

- **Deterministic port.** `--port` > `VX_CLOUD_PORT` > `4321`. The
  port is bound exactly; a busy port is a clean error ("free it, or
  pick another with --port / VX_CLOUD_PORT") — the URL never silently
  moves between restarts.
- **Ingest-only data model.** The dashboard and `/v1/*` read ONLY the
  serve's own SQLite store, populated by the `cloud()` plugin's
  `POST /v1/ingest` push. The serve never reads a workspace
  `cache.db`, so it can be deployed anywhere (cache-entry inventory
  and the full input-fingerprint diff stay local — those live in the
  local `cache.db`).
- **Auth.** Binds `127.0.0.1` by default; a non-loopback bind
  (`--host 0.0.0.0` / `VX_CLOUD_HOST`) is refused without a token — an
  unauthenticated serve on a reachable interface would expose task
  execution. With `--token` set, every request except `/health` and
  `/v1/meta` requires `Authorization: Bearer <t>` (browser transports
  may use `?token=` on `/events`, `/stream`, and the WS upgrade).
  Cross-origin browser WS/SSE handshakes are refused unless the origin
  is same-origin or allow-listed (`--allow-origin`) — a CSWSH / drive-by
  defense. No token → open, but loopback-only.
- **Unix socket.** With `--socket` the same API also listens on a
  0600 unix socket; socket requests bypass the token gate — the OS
  file permissions ARE the auth. The advertisement carries the socket
  path and the `cloud()` plugin's local auto-detect prefers it (TCP
  stays the fallback, and the browser dashboard stays on TCP).
- **Artifact store.** `/v8/artifacts/:hash` speaks the Turbo wire
  core's remote cache already talks — point `VX_REMOTE_CACHE_URL` at
  the serve origin (token = the serve token) and the remote cache
  works with no separate cache server. The store is **trust-scoped**:
  artifacts live under `<ingest-dir>/artifacts/<bucket>/<tier>/`, with
  `<bucket>/<tier>` SERVER-DERIVED from the presented token. A trusted
  token reads/writes `trusted/`; a `--pr-token` (untrusted) reads
  trusted+untrusted but writes only `untrusted/` — so a fork PR can warm
  off `main`'s cache without being able to poison it. Artifacts are
  immutable (a re-PUT of an existing hash is 409). Client-side signing
  tags (`x-artifact-tag`) ride a `<hash>.tag` sidecar. `/v1/meta`
  advertises `artifacts: true` and `trustTiers: true`. See
  `docs/design/cache-trust-scopes-2026-07.md`.
- **MCP.** `POST /mcp` is a dependency-free MCP server (JSON-RPC 2.0
  over streamable HTTP, plain-JSON responses) exposing the dashboard's
  read surface as tools — `list_workspaces`, `list_runs`, `get_run`,
  `run_trends`, `cache_stats`, `why_did_rerun`, `compare_runs` — so an
  AI agent pointed at the serve (with the bearer token as an
  `Authorization` header) can inspect and debug runs.
- **Advertisement.** The serve writes a per-user advertisement at
  `$XDG_RUNTIME_DIR/vx-cloud/serve.json` (fallback: a per-uid temp
  dir; `VX_CLOUD_SERVE_INFO` pins an exact path), so a `vx run` in ANY
  workspace on the machine auto-detects it — zero-config local
  dashboard.

HTTP routes (all return JSON unless noted):

| Route                          | Purpose                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET /health`                  | Liveness probe (`200 ok`) — always open                                                    |
| `GET /v1/meta`                 | Server identity (`name`, vx version, auth mode, `artifacts`) — always open                 |
| `GET /version`                 | Protocol version + channels + RPC capability list                                          |
| `POST /v1/ingest`              | Push endpoint — accepts a `RunSummaryRecord` from the `cloud()` plugin                     |
| `GET /v1/*`                    | Metrics/analytics API (runs, tasks, projects, cache, trends, compare, why, …)              |
| `HEAD/GET/PUT /v8/artifacts/…` | Turbo-wire artifact store (`VX_REMOTE_CACHE_URL` target)                                   |
| `POST /mcp`                    | MCP server for AI agents (JSON-RPC 2.0, plain-JSON responses)                              |
| `GET /events`                  | Server-Sent Events stream of every envelope from every concurrent run                      |
| `GET /stream`                  | NDJSON stream (jq-friendly) of the same                                                    |
| `WS /` (upgrade)               | Bidirectional; accepts both legacy `{ t: 'run', ... }` and JSON-RPC `submit.run` envelopes |
| `WS /v1/agents` (upgrade)      | Distributed-execution agents rendezvous ({workspaceId, session} sessions)                  |

Every wire frame is a JSON-RPC 2.0 envelope per
`docs/design/wire-protocol-2026-06.md`.

## `vx-cloud connect` / `env` / `disconnect` — environments

Docker-context-style **named server environments**, stored per-user in
`$XDG_CONFIG_HOME/vx-cloud/environments.json` (override:
`$VX_CLOUD_CONFIG`; mode `0600` — it holds tokens). Connect once;
every `vx run` on the machine then pushes its summary to the active
server.

```
vx-cloud connect https://vx.corp.example --token vxc_…    # validate + persist + activate
vx-cloud connect <url> --name team --delegate --no-use    # named; opt into run delegation; don't activate
vx-cloud env ls                                           # named servers + the auto-detected (local) row, with reachability
vx-cloud env use team                                     # switch the active environment
vx-cloud env rm staging                                   # delete an entry
vx-cloud disconnect                                       # clear the active pointer (entries + tokens survive)
```

`connect` is a handshake: it probes `/health`, reads the server's
identity from `/v1/meta` (the default `--name`), errors if the server
requires a token and none was given, verifies a given token with one
authenticated request — and only then persists. `VX_CLOUD_ENV=<name>`
overrides the active pointer per-shell without touching the file.

**Resolution precedence** (what the `cloud()` plugin consults, first
match wins):

| #   | Telemetry push                                           | Run delegation (backend)                        |
| --- | -------------------------------------------------------- | ----------------------------------------------- |
| 1   | `cloud({ ingestUrl, ingestToken })` options              | `cloud({ serviceUrl })` option                  |
| 2   | `VX_CLOUD_INGEST_URL` / `_TOKEN` env                     | `VX_SERVICE_URL` env                            |
| 3   | active named environment → `<url>/v1/ingest` + its token | active environment **only if `delegate: true`** |
| 4   | local serve auto-detect (per-user serve.json + live pid) | decline (local runs execute in-process)         |
| 5   | decline — a plain run stays zero-overhead                |                                                 |

`delegate` is opt-in per environment because delegation executes the
run **on the server** against the request's cwd — only correct when
the server shares the filesystem or holds an identical checkout.
Connecting for the dashboard never silently moves execution.

The **remote cache** has its own rung ladder: `cloud({ cacheUrl,
cacheToken })` options > `VX_REMOTE_CACHE_*` env > the active
environment **when its serve advertises the artifact store**
(`/v1/meta` `artifacts: true`, probed lazily once per process) >
decline. Explicit config is never second-guessed — the probe only
fires when nothing else configured the cache and an environment is
actually connected, so a plain run stays zero-network.

## `vx-cloud agent` — distributed-execution agent

Attach this machine's checkout to a serve's session registry and
execute assigned tasks via scoped, fully CACHED core runs
(`docs/design/distributed-execution-2026-07.md`). Replaces the retired
`worker` verb; the retired `coordinator` verb's scheduling now lives
inside `vx-cloud serve`.

```
vx-cloud agent --url <serve-origin>   # (or --coordinator; falls back to
                                      #  VX_SERVICE_URL / the local serve ad)
    --token <t>                       # serve bearer (env: VX_CLOUD_TOKEN)
    --capacity <n>                    # max concurrent assignments (default 1)
    --session <s>                     # session key (default: VX_AGENT_SESSION >
                                      #  CI-derived > 'local')
    --idle-timeout <ms>               # self-terminate when idle (default 10 min;
                                      #  0 = never)
    --label <l>                       # capability label (repeatable)
```

Behavior:

- Startup checks: git present, CLEAN worktree (a dirty agent exits 1
  before poisoning keys), commit + workspace-id capture.
- Points `VX_REMOTE_CACHE_URL`/`_TOKEN` at the serve (when unset), so
  every scoped run reads/writes the serve's `/v8/artifacts` store —
  the cache IS the artifact transport between agents. Sets
  `VX_CLOUD_AGENT=1` so `cloud()`'s telemetry rung declines.
- Registers over `/v1/agents` with
  `agent:hello { protocol, workspaceId, session, commitSha, capacity }`.
  Protocol or commit mismatch → `agent:refused` naming both, exit 1.
- Per `task:assign { taskId }`: a scoped in-process `run()` of the
  exact task id WITH its dep closure — deps restore as warm hits from
  the shared store, the task executes, its artifact uploads before
  `agent:done` reports core's `OutcomeView`. Only the assigned task's
  events forward; dep restores stay silent.
- Exits 0 on clean drain or idle timeout EVEN WHEN TASKS FAILED (the
  submitting run owns the aggregate verdict); 1 on refusal, dirty
  tree, or unexpected disconnect.

Enable distribution on the submitting run with
`VX_CLOUD_DISTRIBUTE=<n>` (or `cloud({ distribute: n })`) — the
`cloud()` backend then prepares the graph, submits it to the serve
(`dist:submit`), self-registers as an agent, renders the relayed
stream, and materializes outputs locally. Refusal gates (dirty tree,
non-remote cache policy, `-- forwardArgs`, persistent tasks) fall back
LOUDLY to a normal local run; an unreachable serve is a hard error.

## `vx-cloud dev` — devtools hub

Foreground devtools hub that ingests forwarded NDJSON events from a
local `vx run` and renders them through a connected web client.
Needs the optional `devframe` package.

```
vx-cloud dev                     # bind a kernel-assigned local socket
```

Optional and dev-time only. Production observability is the
telemetry-plugin path: declare `otel()` from `@vzn/vx-otel` in
`vx.workspace.ts` and set `OTEL_EXPORTER_OTLP_ENDPOINT` (the endpoint
alone no longer auto-exports), or push run summaries to a `vx-cloud
serve` via the `cloud()` plugin.

## Output format

`vx run` emits framed blocks. Stdout/stderr from each task is
buffered until completion, then dumped inside the block — so
concurrent tasks never interleave their lines.

Frame anatomy:

```
┌─ <id> > <outcome header>      restored-local • abc12345 / failed (exit N) / …
├─ command                      only for executed tasks (success or failed)
<the command, raw>
├─ stdout                       only when non-empty
<stdout lines, raw>
├─ stderr                       only when non-empty
<stderr lines, raw>
├─ sandbox violations (N)       when the sandbox recorded violations
<violation lines, raw>
└─ <id> ── (<duration>) <outcome word>
```

Section headers (`├─ …`) and frame corners render dim; the id keeps
its identity coloring. Content lines are **raw** — no left border, no
indent — so long lines wrap without colliding with frame glyphs and
copy/paste yields the verbatim output. Every block (and every live
frame close in focused flow) is followed by a blank line so frames
never collide with the next one-liner. A persistent task's frame is
marked with a cyan `▸` after `┌─`/`└─`, and its close reads `running`
(the child is still alive).

There is **no top-of-run banner** — the run context lives in the
footer. A broad run looks like:

```
 ⇢     4ms success  local  @vzn/vx#format-check
 ⏺  5.20s success  miss   @vzn/vx#test

──────────────────────────────────────────────── vx 0.0.0
  projects  ▰▰▰▰▰… (affected vs workspace bar)
            1 affected · 3 total
  tasks     ▰▰▰▰▰… (failed/success/skipped meter)
            2 success · 2 total
  cache     ▰▰▰▰▰… (miss/up-to-date/local/remote meter)
            1 miss · 1 local

  info      8 workers · local cache
  time      5.34s (max 5.20s · avg 2.6s · min 4ms)
```

Group tasks emit no framed block by design (they aren't real tasks);
running a group focused surfaces its real member tasks instead.

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
environment, `vx run` layers a remote cache on top of the local one
(a plugin's `cache` capability, when declared, wins over the env
vars).

Reads try local first, then remote (hydrating local on remote hit),
with a background prefetch pass overlapping remote GETs with
execution. Writes go to local immediately; the remote upload is a
fire-and-forget background task drained at end of run — failures are
logged via `onRemoteError` but never fail the build.

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
every task to a `runs` table in `cache.db` (ULID `run_id`, hrtime
wallclock spans, cpu_ms, peak RSS, status, cache_hit flag) plus one
`invocations` header row per run (command, git/CI context, tags,
counts). The SQLite file IS the API:

```sh
sqlite3 .vx/cache/cache.db "
  SELECT project, task, status, duration_ms
  FROM runs
  WHERE run_id = (SELECT run_id FROM runs ORDER BY id DESC LIMIT 1)
  ORDER BY duration_ms DESC;
"
```

The schema is documented in
[`caching.md` § SQLite tables](./caching.md#sqlite-tables). For a
browsable view, run `vx-cloud serve` and open the dashboard.

## What's still missing vs Turbo

Tracked in detail in [`comparison.md`](./comparison.md). Recap of the
gaps visible from the CLI:

- `--continue=<mode>` (current behavior: independent siblings continue;
  dependents are skipped — Turbo's middle setting, without the flag).
- `--output-logs hash-only` (the other three modes shipped).
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
  // Optional 4-axis cache control; omit for everything-on.
  cache: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
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
- `prepareRun(options, log)` — the shared setup (discovery → configs →
  graph → cache). What a coordinator embeds.
- `defineProject` / `defineWorkspace` — identity helpers for type
  inference in user configs.
- `RunOptions` / `RunSummary` / `TaskOutcome` types are re-exported
  from `@vzn/vx`, alongside the plugin (`VxPlugin`), telemetry
  (`TelemetrySink`, `RunSummaryRecord`), wire (`RunRequest`,
  `RunBackend`), and metrics-query surfaces — see `src/index.ts`.

A `log: Logger` option lets embedders swap the default framed-block
logger for a custom one (e.g. JSON-line emission). Custom loggers
always see plain text (colors are off when a non-default logger is
provided).

The CLI dispatcher (`run(argv)` in `src/cli/index.ts`) is not part of
the public package exports; `bin.ts` calls it directly.

### Failure propagation — `--continue`

`--continue[=never|deps-ok|always]` controls what a failed task takes
down with it:

- **`deps-ok`** (default): the failure's transitive dependents are
  skipped; independent siblings keep running.
- **`never`**: fail fast — the first failure stops dispatch. In-flight
  tasks finish naturally; everything not yet started (cache restores
  included) completes as skipped.
- **`always`** (bare `--continue`): dependents run even when an
  upstream failed. Sound under pure-input hashing — a failed upstream
  still carries its input key, so dependents derive exactly the keys a
  healthy run derives.

The mode rides the wire, so delegated and distributed runs honor it.
