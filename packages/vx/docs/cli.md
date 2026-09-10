# CLI reference

The `vx` binary is the user-facing entry point. The implementation is
intentionally simple: a hand-rolled argv parser (no commander / yargs)
in `src/cli/index.ts` dispatches to per-subcommand handlers under
`src/cli/<name>.ts`. The flag surface is aligned with
[Turborepo's `turbo run`](https://turborepo.com/docs/reference/run)
so existing Turbo users can swap in with minimal muscle-memory churn.

```sh
# Standalone binary via npm (no Bun required on target):
npm install -g @vzn/vx

# From source (Bun ≥ 1.4):
bun src/bin.ts --version
```

## Top-level shape

```
# Core
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx watch [OPTIONS] TASK [-- forwarded-args...]
vx cache prune [--older-than <duration>] [--max-size <size>]
vx lock [--check]
vx init [--dry] [--force]
vx show [PROJECT[#TASK] | TASK] [--format pretty|json]
vx info
vx stats              # deprecated alias of vx info
vx upgrade [tag]      # self-update a compiled binary

# Meta
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

**Every requested name must resolve.** If any positional matches no
project in scope, the run refuses to start — `no projects declare
task(s): <name>` on stderr, exit 1, with `Did you mean <task>?` when a
declared task (or, for `pkg#task`, a runnable spec) is within two edits
— even when the other names resolved fine. A bare name declared by only SOME projects is normal and stays
green; the guard fires only when a name matched nowhere. So a CI job
running `vx run lint test typecheck` goes red the day `typecheck` is
renamed, instead of silently running two of three.

(No `-V` for version; `vx --version` only — matches Turbo.)

`vx <verb> --help` (and `-h`) prints this reference cut to that core verb —
its usage lines and sections, then `Full reference: vx help` —
and every argument error points at it.
Past a `--` the flag belongs to the command being run, so
`vx run build -- --help` forwards it to the task instead. A plugin verb
owns its own arguments, `--help` included.

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
| `<pattern>`     | Match by package name. `*` matches any characters, including `/`.             |
| `./<dir>`       | Match packages whose dir is at or under `<dir>` (relative to workspace root). |
| `{<dir>}`       | Same as `./<dir>`.                                                            |
| `.`             | The workspace root — i.e. EVERY package, not the one you are standing in.     |
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

**It selects the CHANGED projects, not their dependents.** A change in
`utils` runs `utils`' task; it does not run `app`'s, even when `app`
depends on `utils`. That is Turbo's `[<base>]` semantics, and it is the
right default for "test what I touched" — but for "prove I didn't break
anything downstream" you want the dependents too, which is the `...`
prefix from the filter table:

```bash
vx run test --affected              # only what changed
vx run test --filter '...[main]'    # what changed + everything depending on it
```

The task graph does not close this gap for you: `dependsOn` pulls a
task's DEPENDENCIES in, never its dependents.

It's a pure sugar for `--filter '[<base>]'`; both are resolved by
`src/workspace/affected.ts`, which unions `git diff` against `<base>`
with `git ls-files --others` so a brand-new untracked source file counts
as a change (input hashing sees it, so `--affected` must too).
`vx-lock.json` is filtered out of the changed set — a `vx lock`
re-write never marks every project affected.

**A lockfile change selects everything.** The root lockfiles and
`pnpm-workspace.yaml` are folded into the [workspace
fingerprint](./caching.md), which is part of _every_ task's cache key —
so a `bun install` / `pnpm update` invalidates the whole cache. Those
files sit at the workspace root and belong to no project, so mapping
changed paths to project directories would select nothing; `--affected`
widens to every project instead, for the same reason it unions in
untracked files. Only the ROOT copies count: a lockfile vendored inside
a package is not hashed and selects just that package.

**A file your config IMPORTS selects that project.** vx hashes the
resolved config, so a shared preset a `vx.config.*` imports is part of
the cache key — and selection follows the same rule. Editing
`shared/preset.ts` selects every project whose config imports it,
directly or through another shared file, even though the file belongs
to no project and no `workspaceFiles` glob names it. The scan is
STATIC (nothing is evaluated) and follows RELATIVE specifiers only; a
bare specifier is a package, and a lockfile change already selects
everything. It stops at a project boundary: a config importing
`../../packages/lib/preset.ts` gets the edge, but `preset.ts`'s own
imports inside `lib` do not reach further — `lib` is already selected
by containment. Import your helpers by bare specifier to opt out. See
[`docs/modules/config-imports.md`](./modules/config-imports.md).

**Nothing changed exits 0.** When the selection comes only from
`--affected` / `[<ref>]` and resolves to zero projects, vx prints
`nothing affected since <ref>` and exits 0 — a docs-only commit must not
fail `vx run lint test build --affected=origin/main`. A name or path
pattern that matches nothing is still an error (a probable typo), and a
pattern that matches nothing alongside one that matched is warned about
on stderr.

**An empty selection never cancels an anchored task.** Project scope
applies to bare names only, so `vx run app#deploy build
--affected=origin/main` with nothing changed still runs `app#deploy`
(vx notes `nothing affected since <ref> — running app#deploy only` on
stderr). Only a bare-name-only invocation short-circuits to exit 0.

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

| Flag                               | Type           | Default                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--filter <pattern>`               | repeatable     | (none)                             | pnpm-style filter DSL (see above). `--filter=<pattern>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--all`                            | boolean        | off                                | Select every project that declares the task.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--affected[=<base>]`              | optional value | off                                | Filter to projects changed since `<base>` (default `origin/HEAD`).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--exclude-dependencies[=<names>]` | optional value | off                                | Drop `dependsOn` edges. No value = all (just the requested task runs); comma-list = drop only those names. An empty `=` value is a parse error (ambiguous — see below).                                                                                                                                                                                                                                                                                                                    |
| `--concurrency <n>`                | int or `<n>%`  | `navigator.hardwareConcurrency`    | Maximum parallel tasks. `1` serializes; `50%` is half the CPUs (rounded, never below 1; over 100% is allowed for I/O-bound work). `--concurrency=<n>` form too.                                                                                                                                                                                                                                                                                                                            |
| `--no-cache`                       | boolean        | off                                | Disable caching entirely (no reads, no writes); output globs are NOT cleaned.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--force`                          | boolean        | off                                | Re-execute everything (skip cache reads) but still REFRESH the cache (writes stay on). Output globs are cleaned (so the saved snapshot is clean).                                                                                                                                                                                                                                                                                                                                          |
| `--cache <spec>`                   | value          | all axes on                        | Per-layer read/write control. See below. An EMPTY spec (`--cache=`) is a parse error — it applied nothing and left every axis on; pass `--no-cache` to disable them all.                                                                                                                                                                                                                                                                                                                   |
| `--cache-dir <path>`               | value          | workspace `cacheDir` / `.vx/cache` | Cache directory override, resolved relative to cwd (absolute paths used as-is). Beats the `defineWorkspace({ cacheDir })` field and the `.vx/cache` default, for every cache the run opens — the config-evaluation cache that `--affected` owners, the picker and the watch sweep read included, so the workspace's default dir is not created beside it. A per-run knob — never folded into a cache key. `--cache-dir=<path>` form too; the space form rejects a value starting with `-`. |
| `--retry <n>`                      | value          | `0`                                | Re-run a failed task up to `n` more times. Run-level default only: a task's own `exec.retries` wins (even an explicit `0`). Never affects cache keys. `--retry=<n>` form too.                                                                                                                                                                                                                                                                                                              |
| `--continue[=<mode>]`              | value          | `deps-ok`                          | What a failed task takes down with it. `never` stops dispatch on the first failure; `deps-ok` (default) skips only its dependents; `always` (bare `--continue`) runs dependents anyway. See § Failure propagation.                                                                                                                                                                                                                                                                         |
| `--timeout <ms>`                   | positive int   | none                               | Default per-task timeout for tasks without their own `exec.timeout`. Sits above `VX_TASK_TIMEOUT` + workspace `timeout`; per-task `exec.timeout` always wins. A runaway task is killed + `failed`. Never affects cache keys. `--timeout=<ms>` form too.                                                                                                                                                                                                                                    |
| `--memory <size>`                  | size           | total system RAM                   | Memory budget that per-task `exec.resources.memory` reservations pack against (`8GB`, `512MB`). Pass it in cgroup-limited containers — the default reads the HOST's RAM. Reservations are per-task config, not flags. Never affects cache keys. `--memory=<size>` form too.                                                                                                                                                                                                                |
| `--frozen`                         | boolean        | off                                | Load configs from `vx-lock.json` instead of evaluating (CI) — the run's, and the ones `--affected` owners and the picker select from. See § `--frozen`.                                                                                                                                                                                                                                                                                                                                    |
| `--output-logs <mode>`             | value          | flow-derived                       | `full` \| `errors-only` \| `hash-only` \| `none` — explicit output override. See § `--output-logs`. `--output-logs=<mode>` form too.                                                                                                                                                                                                                                                                                                                                                       |
| `--download <mode>`                | value          | `all`                              | `all` \| `toplevel` \| `none` — where a REMOTELY-executed task's outputs land. `none` leaves them in the remote CAS and fetches lazily, only when a locally-placed task needs them. Never affects cache keys. See § `--download`. `--download=<mode>` form too.                                                                                                                                                                                                                            |
| `--verbosity <n>`                  | int (0+)       | `0`                                | `1` or more prints a per-task summary table after the framed blocks. `--verbosity=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                           |
| `--dry[=text\|json]`               | optional value | off                                | Print the task graph + predicted cache hit/miss; skip execution.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--graph[=<path>]`                 | optional value | off                                | Emit Graphviz DOT (stdout if no path); skip execution.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--summarize[=<path>]`             | optional value | off                                | Write per-run JSON to `<cacheDir>/runs/<run_id>.json` (or the explicit path).                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--profile[=<path>]`               | optional value | off (`profile.json` when set)      | Write Chrome-trace JSON of the run's wallclock spans.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--tag <k=v>`                      | repeatable     | (none)                             | Label this invocation. Recorded on the run's `invocations` row so dashboards can filter runs. `--tag=k=v` form too.                                                                                                                                                                                                                                                                                                                                                                        |
| `--report[=markdown]`              | optional value | off                                | After the run, print a markdown run report to stdout. Only `markdown` is supported (`json` is reserved).                                                                                                                                                                                                                                                                                                                                                                                   |
| `--report-file <path>`             | value          | off                                | After the run, APPEND the same markdown report to `<path>`. Use this for `$GITHUB_STEP_SUMMARY` — redirecting stdout captures the whole run log too. `--report-file=<path>` form too.                                                                                                                                                                                                                                                                                                      |

Mutual exclusion:

- `--dry` and `--graph` — both skip execution; pick one.
- `--dry` or `--graph` with `--summarize` or `--profile` — the latter
  two need a real run.

Unknown flags are a parse error (`unknown flag: --foo`), naming the
nearest documented `vx run` flag when one is within two edits
(`unknown flag: --concurency (did you mean --concurrency?)`).

**Optional-value flags take their value with `=` only.** `--affected`,
`--exclude-dependencies`, `--dry`, `--graph`, `--summarize`, `--profile`,
and `--report` are all valid bare, so a following word is
always read as a task name — `vx run --affected build` means "run
`build`, affected scope", and there is no way to tell that apart from
"`build` is the git base". Write `--graph=out.dot` or
`--affected=origin/main`. Getting it wrong is loud, not silent: the value
becomes a positional that matches no project, so the run refuses to
start (see "Every requested name must resolve" above).

`--exclude-dependencies=` with an EMPTY value is rejected rather than
guessed — "drop every edge" and "drop none" are both plausible readings.
Pass bare `--exclude-dependencies` for the first, omit the flag for the
second.

Value flags (`--filter`, `--concurrency`, `--output-logs`,
`--verbosity`, `--cache-dir`, `--report-file`, …)
accept both `--flag value` and `--flag=value`. In the space form,
`--cache-dir` and `--report-file` reject a value
starting with `-`: that is always a swallowed flag (an unquoted empty
shell variable), never a path or task id. Use the `=` form for a literal
leading dash.

**Numeric flags take a plain decimal integer.** `--concurrency`,
`--timeout`, `--retry` and `--verbosity` reject hex (`0x10`), exponent
(`1e3`), fractional (`2.7`), signed (`+4`) and space-padded forms, plus
anything past `2^53` (it would parse to a number you did not type).
These all used to be silently reinterpreted — `--concurrency 0x10` ran
16 workers. `--memory` takes a size string (`512MB`), same rule for its
digits.

An empty `=` value on an OPTIONAL-value flag means "no value", so it
takes that flag's documented default: `--profile=` writes `profile.json`
and `--summarize=` writes `<cacheDir>/runs/<run_id>.json`, exactly like
their bare forms. Value flags that have no bare form (`--retry=`,
`--timeout=`, `--memory=`, `--cache-dir=`, `--filter=`, `--cache=`)
reject an empty value instead.

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

`local:` means "don't serve hits out of the pre-existing local cache" —
a remote hit is still delivered (the artifact has to land on disk to be
extracted), it just never short-circuits the remote read.

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

Per-task visibility by outcome. Each cell is the SHAPE of what prints —
`silent`, `one-liner`, `frame`, or a conditional; the table is pinned to
the renderer by `tests/output-doc-drift.test.ts`, so the vocabulary is
fixed:

| Outcome                | focused (requested task) | focused (dependency)      | broad                     | CI / `full`                  |
| ---------------------- | ------------------------ | ------------------------- | ------------------------- | ---------------------------- |
| executed               | frame                    | silent                    | one-liner                 | frame                        |
| restored-local/-remote | frame                    | silent                    | silent                    | frame, or one-liner if quiet |
| up-to-date             | frame                    | silent                    | silent                    | frame, or one-liner if quiet |
| failed                 | frame                    | one-liner + frame replays | one-liner + frame replays | frame                        |
| skipped                | one-liner                | silent                    | silent                    | one-liner                    |

What the shapes mean in each column:

- **focused, requested task.** The frame is LIVE when it is the only
  requested task: `┌─` prints at task start, the command's output (or a
  hit's replayed stdout) streams raw between the brackets, `└─` closes
  it. With several requested tasks the same frame is buffered and
  emitted atomically (see below). Every outcome that ran or was cached
  gets one — including an `up-to-date` hit, whose frame carries the
  `$ cmd` line so a requested task looks the same whether it ran or not.
- **skipped** is the exception: it never started, so no frame was opened,
  and it produced nothing a frame could hold. The one-liner says
  everything.
- **`frame, or one-liner if quiet`** — a cache hit with stored stdout is
  worth a frame (the output is the point); a hit with nothing to replay
  compresses to one line, which is what keeps a 2000-task warm run
  readable.
- **`one-liner + frame replays`** — the `◼ … failed` line prints
  immediately; the full frame is held and replayed at run end.

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
atomic block at completion. The shapes are the ones in the table above —
anything that ran or was cached gets a full frame, `up-to-date`
included; only `skipped` is a one-liner. The blocks are blank-line
separated and never interleave. A single `vx run test` keeps the
live-stream experience unchanged.

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
`errors-only` (only failed tasks print; the CI noise budget),
`hash-only` (one line per task — outcome word, task id, cache key — and
no log output at all; the run's audit trail of which key each task
resolved to, Turbo parity), `none` (no per-task output). The
end-of-run summary always prints.

### Failure propagation — `--continue`

`--continue[=never|deps-ok|always]` controls what a failed task takes
down with it:

- **`deps-ok`** (default): the failure's transitive dependents are
  skipped; independent siblings keep running.
- **`never`**: fail fast — the first failure stops dispatch. In-flight
  tasks finish naturally; everything not yet started (cache restores
  included) completes as skipped.
- **`always`** (bare `--continue`): dependents run even when an
  upstream failed — to surface every failure in one pass. A task
  downstream of a failure (directly, or through successes built on it)
  runs and cleans its outputs as usual but is **never saved**: under
  pure-input hashing its key is the one a healthy run derives, while its
  bytes were built on a partial tree, so caching it would hand the next
  clean run a stale hit. A cache hit still restores (that artifact came
  from a healthy run), and the next run without the failure rebuilds the
  rest.

The mode rides the wire, so distributed runs honor it.

### `--download <mode>`

Where a **remotely-executed** task's outputs land. `all` (default)
downloads every task's outputs to this machine as it completes —
today's behaviour, byte for byte. `toplevel` brings home only the tasks
you actually asked for — including the real tasks behind a requested
group — and leaves intermediates remote. `none` leaves
them in the remote CAS
and fetches them **lazily**: only when a locally-placed task in the
same run actually needs them (Bazel calls this "build without the
bytes"). A CI job that only wants the verdict moves no output bytes at
all.

Locally-executed tasks always write in place and ignore the flag, and
`exec.remote: 'only'` still means never — `--download` cannot override
it in either direction. **It never affects a cache key**: transfer
tuning cannot change what a command produces.

One safety gate: a task whose outputs another task's `cache.inputs`
globs could read on disk is silently kept eager, because deferring it
would make that key depend on whether the bytes arrived. `--dry` reports
how many tasks would keep their outputs remote and names each downgrade,
so a run that defers nothing says why. A run in which any task declares a
`cache.inputs.runtime` / `workspaceRuntime` command defers **nothing**:
a shell command's reads cannot be bounded, so vx cannot prove it will
not read a deferred output (the same reason vx refuses to infer inputs
by tracing). When bytes are fetched later, vx saves an ordinary
cache entry for them, so the next run is a plain local hit.

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
  ▶  @vzn/vx#test          cache miss — would exec   68595e49  ~72.64s

3 task(s) planned, 2 cache hits (2 local), 1 would run.
predicted: ~72.64s wall · ~72.64s total execution
```

**Time prediction.** A would-run task with recorded history shows its
typical executed duration (`~p50` over its recent non-hit runs in the
local `cache.db`). The footer predicts the run: `wall` is the longest dependency
chain of would-run cost (cache hits restore near-instantly and count
as 0), `total execution` is the sum across would-run tasks. Tasks with
no history count as 0 and are called out (`N tasks without history
(+?)`) — the totals are honest lower bounds. The footer is omitted
when nothing would run or when no would-run task has history.

**Placement.** When the workspace's plugins supply more than one
executor, each row carries the one the task would land on (`@spy-remote`;
`@local` for the floor; `@noop` for an `exec.remote: 'only'` task no
remote accepts, which the run would skip rather than run here) and the
JSON object carries it as `executor`. With one executor there is
nothing to choose and the column is absent. If an executor hook throws
or returns something that is not an executor, the plan still prints —
`--dry` never fails over a label — but says so on the status line, in
the plugin's name: `[vx] placement not shown — plugin 'x' … (the run
would refuse on it)`.

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
  ],
  "predicted": { "wallMs": 72640, "workMs": 72640, "unknownCount": 0 }
}
```

Each would-run task with history also carries `p50Ms`; `predicted` is
present whenever local history was readable.

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
  "ok": true,
  "exitCode": 0,
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
  "aborted": [],
  "summary": {
    "successful": 3,
    "failed": 0,
    "skipped": 0,
    "cachedLocal": 2,
    "cachedRemote": 0,
    "aborted": 0,
    "total": 3
  }
}
```

Default path: `<cacheDir>/runs/<run_id>.json`. hrtime fields are
strings (bigints serialized as strings) to preserve ns precision
through JSON.

**`ok` / `exitCode`** are the run's verdict — the same value the CLI
exits with. Gate on these rather than re-deriving a pass from the
buckets: a run can be red without a single failed task (see `aborted`).

**`tasks[]` and `summary` describe the same population**, so
`tasks.length === summary.total` always holds. Group tasks (no `exec`)
are in neither — they do no work.

**`aborted[]`** lists tasks whose child was killed by a shutdown signal
(Ctrl-C, an external `kill`, a self-terminating script). Such a task did
not finish on its own terms, so it joins no outcome bucket and no
`total` — but it does make the run red, so it is listed separately with
its signal exit code, and counted as `summary.aborted`.

**`noCache: true`** marks a task that declares no `cache` block — it
executes every run by design, so a hit rate should leave it out of the
denominator. The key is present only when true; every other row is
unchanged. Its `hash` is still set: dependents fold it.

**`durationMs` is always what THIS run spent on the task.** For a cache
hit that is the probe + restore, not the exec time the entry was stored
with — so it is small even for an expensive task. The work a hit
_skipped_ is a different number; `--report`'s "N saved" is the surface
that reports it.

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
`Cache` is its provenance (`miss` / `no-cache` for a task with no `cache`
block, which never consulted it / `local` / `remote` / `up-to-date` /
`—`). Aborted tasks (a Ctrl-C teardown) are excluded from the totals but
still get a row and an `N aborted` count, so a red report with no failing
row still says why. Group tasks (no `exec`) get neither — they are not
work, and the header's counts match the terminal summary and
`--summarize` exactly.

The two durations in the header mean different things, and the
distinction is the point:

- **`N total`** sums `Duration` over the tasks that actually EXECUTED —
  the time this run spent.
- **`N saved`** sums the exec times the cache hits SKIPPED, read from
  each entry as it was stored. It is deliberately not the hits'
  `Duration` column, which is the restore they cost this run: summing
  that reported a task taking 2.01s cold as "6ms saved".

Only `markdown` is supported today (`json` is reserved; a bad value is a
parse error). Built purely from the run's outcomes after it returns — it
adds zero cost when both flags are absent.

### `--report-file <path>`

Writes the same markdown report to a file instead of (or as well as)
stdout, and is the form to use for a CI step summary:

```sh
vx run ci --report-file="$GITHUB_STEP_SUMMARY"
```

**Do not redirect stdout for this.** The report itself is machine-clean,
but stdout is not vx's alone — the status logger writes frames, meter
bars and `::group::` workflow commands to the same stream, so
`--report=markdown >> "$GITHUB_STEP_SUMMARY"` puts the entire run log
into the step summary above the table.

The report is **appended**, never truncated: `$GITHUB_STEP_SUMMARY` is a
shared, append-only file that other steps in the same job also write to,
so overwriting it would silently discard their content. Passing both
flags writes the report to stdout AND appends it to the file. A write
failure is reported (`vx: failed to write report to …`) but does not
change the exit code — the run already happened, the same contract
`--summarize` and `--profile` follow.

### `--tag <k=v>`

Labels the invocation. Repeatable; `--tag=k=v` form too. The pair is
split on the **first** `=`, so values may contain `=` (e.g. a URL). An
empty key is a parse error. Tags are recorded on the run's
`invocations` row so dashboards can filter runs by label.

## Sandbox

Sandbox isolation is opt-in **per task** via an `exec.sandbox` block in
the task's config — there is no `--sandbox` CLI flag. See
[`modules/sandbox-runtime.md`](./modules/sandbox-runtime.md) for the
full reference.

```ts
// vx.config.ts
export default {
  tasks: {
    build: {
      exec: {
        command: 'tsc',
        sandbox: {
          allow: {
            read: ['.'],
            write: ['dist/**'],
          },
        },
      },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
}
```

The grants are the task's whole permission surface — nothing is derived
from `cache`, and the only thing core adds is `node_modules` plus the
workspace packages linked there. Enforcement anchors at the workspace
root (a task never leaves its project); only denials inside the project
are reported.

Policy: **fail on violation.** Any task that touches a path it didn't
declare either fails naturally (Linux: `ENOENT` from bwrap's
mount-namespace hide) or is flagged via the macOS violation store
and forced to exit non-zero. No cache is written for a failed task.

`vx run` lazily initialises the sandbox runtime only when at least
one task in the graph declares `exec.sandbox`. If runtime deps are
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
   changes. A task's own declared outputs (`cache.outputs.files`,
   `outputs.workspaceFiles`; a plugin's `project` stage counts, as in
   a run) never trigger a re-run — a cycle that writes `dist/` is not
   an edit — and neither do `node_modules`,
   `.git` or the cache directory. A write the task did NOT declare (a
   task with no `cache` block declares nothing) is caught by content:
   a file whose bytes did not change since the loop last saw it is not
   an edit, so a task that writes into its own project costs one extra
   cycle instead of re-running forever. When any project's config declares
   `cache.inputs.workspaceFiles`, the per-project watchers are swapped
   for ONE recursive root watcher (boundaries are off for those globs,
   so any workspace file can be an input). `vx watch: watching …` is
   printed only after every watcher has reported a probe file written
   under it (`.vx-watch-probe`, re-written on a short backoff until its
   event arrives, then removed): on macOS a directory watcher can return
   before its event stream is live, and an edit in that gap is silently
   lost — so the line is a promise, not a hope. A
   watcher that stays silent for 2 s is kept, with a warning that early
   edits there may be missed.
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
- The run's **resolved cache directory**, wherever it is. `.vx/` covers the
  default, but `defineWorkspace({ cacheDir })` and `--cache-dir` can put it
  anywhere; watching it would let vx's own cache writes trigger the next
  cycle, which writes again — a loop that never settles.

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
- `--report` / `--verbosity <n>` (n > 0) — both format ONE run's
  result; a watch loop has no single run to report. (`--verbosity 0`
  is accepted: it asks for what watch already prints.)

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
vx cache prune ... --dry-run                # Say what either policy would reap; delete nothing.
vx cache prune ... --cache-dir <path>       # The cache a run with the same flag uses.
```

At least one of `--older-than` / `--max-size` is required. Both may
be combined: age-based eviction runs first, then LRU eviction if the
total is still over the size cap.

After eviction, prune sweeps the cache directory for **orphans**: a
`<hash>.tar.zst` the index has no row for (a `SCHEMA_VERSION` bump
drops every table and leaves the artifacts behind — the first run
after the upgrade says `cache index reset: schema v24 → v25` and names
this verb; a deleted `cache.db` does the same) and a `<hash>.tar.zst.tmp-*` a save that
crashed never renamed. Nothing else reclaims them — a lookup starts at
the row, so an orphan is never a hit, and only a save of the same key
overwrites it. Files younger than one hour are left alone: a save
renames its artifact into place before the row commits, so a fresh
row-less file is a save in flight. The sweep runs on every prune, under
either flag, and reports separately from the policy's evictions.

Both flags take either form: `--older-than 30d` or `--older-than=30d`.

**Duration units**: `s`, `m`, `h`, `d`, case-insensitive. Examples:
`30d`, `24h`, `60m`, `30s`, `30D`.

**Size units**: `K`, `M`, `G`, `T` (powers of 1024), case-insensitive.
Optional `B` suffix is accepted. Examples: `500M`, `1G`, `100K`, `2T`,
`500MB`, `1gb`. A bare number is refused here: `--max-size 10` would
read as ten bytes and evict nearly everything, and nobody means that —
write `10G`, or `10B` when bytes really are the unit.

**A zero bound is rejected.** `--max-size 0` and `--older-than 0d` would
evict every entry in the cache, which is far more often a
computed-to-zero retention than an intent — and no flag combination
expresses "wipe the cache" (running with neither flag is an error, not a
full prune). Delete the cache directory when that is really what you
want.

```
$ vx cache prune --older-than 30d
Pruned 42 entries (1.3 GB freed)

$ vx cache prune --older-than 7d --max-size 500M
Pruned 18 entries (320.1 MB freed)

$ vx cache prune --older-than 30d      # after a SCHEMA_VERSION bump
Pruned 0 entries (0 B freed), reaped 42 orphaned artifacts (1.3 GB)

$ vx cache prune --older-than 30d --dry-run
Would prune 42 entries (1.3 GB), would reap 3 orphaned artifacts (12.4 MB)
```

`--dry-run` picks the victims under the same policy and counts the
orphans the sweep would take, then returns without touching the index
or the directory; the real prune with the same flags reaps exactly what
it named (an in-flight save aside).

Exit codes:

- `0` — pruning completed (zero or more entries evicted).
- `1` — parse error, missing policy, or workspace-discovery error.

`vx cache prune` resolves the workspace root from cwd and honors a
`defineWorkspace({ cacheDir })` override — it prunes the same
directory a run would use. `--cache-dir <path>` (cwd-relative, as on
`vx run`) names another one, so a run that wrote elsewhere can be
pruned there.

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

## Releasing (maintainers)

A GitHub release publishes everything: `release.yml` builds the four
binaries, ad-hoc signs the darwin ones and attaches them; `npm.yml`
builds the five npm packages (`@vzn/vx` and one per platform) and
publishes them with **npm trusted publishing** — the job's OIDC token
is exchanged for a short-lived credential and provenance is attached,
so no long-lived npm token exists anywhere. Both publish loops skip a
package already on the registry, so a re-run (`npm publish` →
_Run workflow_ with the version) resumes where it stopped.

One-time setup, per package, on npmjs.com → package → Settings →
Trusted Publisher → GitHub Actions: owner `vznjs`, repository `vx`,
workflow `npm.yml`, environment left blank. Do this for `@vzn/vx`,
`@vzn/vx-darwin-x64`, `@vzn/vx-darwin-arm64`, `@vzn/vx-linux-x64` and
`@vzn/vx-linux-arm64`. Then delete the `NPM_TOKEN` repository secret:
the workflow no longer reads it, and npm restricts classic tokens for
direct publishing (the `E401 token is invalid` that stopped v0.0.17).
Every `uses:` in both workflows is pinned to a commit SHA with the
version in a comment; bump the SHA and the comment together.

## `vx upgrade`

Self-update the compiled binary in place: downloads the release asset
for this platform and atomically replaces the running executable
(`vx upgrade <tag>` pins a specific release; default latest). Named
`upgrade` per CLI convention (`bun upgrade`, `deno upgrade`). Refuses
when running from source — use `git pull`. (An npm-installed vx
updates with `npm update -g @vzn/vx` instead.)

## `vx init`

Scaffold a workspace that comes from nowhere: one `vx.config.ts` per
package from its `package.json` scripts, plus `vx.workspace.ts`
declaring the local executor and cache. The same mapping as `@vzn/vx-migrate
--from scripts`, with the same `--dry` / `--force` flags; the one
difference is a workspace with no scripts at all, which `init` still
scaffolds (the workspace file, a printed example config, and the next
command to run) where `migrate` reports nothing to convert. Every
generated config is typed for the editor through
`import type { ProjectConfig } from '@vzn/vx'` and `satisfies
ProjectConfig` — a type-only import Bun erases, so the file loads in a
workspace that runs the `vx` binary without the package installed. The
workspace file takes the same form (`satisfies WorkspaceConfig`): a
runtime `import { defineWorkspace } from '@vzn/vx'` loads a second copy
of core into every run — ~17 ms on a two-package workspace, measured
2026-09-09, for an identity function — so the scaffold never pays it. A
workspace that does import `@vzn/vx` (or a plugin package) at runtime
without having installed it is told so, with the install command.

Each script becomes a task with its command verbatim. `build` gets
`dependsOn: ['^build']` and **no cache block** — under a
`TODO(vx-migrate)` showing the block to add with the package's real
inputs and outputs. A task without a cache block always runs; a block
with EMPTY outputs is not "uncached" but a no-output task that hits on
unchanged inputs and skips the build with nothing to restore (a deleted
`dist` stays deleted under a green `up-to-date` run — what `init`
generated until 2026-09-04), and a guessed `dist/**` would restore the
wrong tree for every package that writes elsewhere. `test` / `typecheck` wait for
`build` when the package has one (`lint` reads sources and gets no
edge); `dev` / `start` / `serve` / `watch` /
`preview` become persistent tasks with a TODO to add `readyWhen`.

On a repo that already has `turbo.json` or an Nx workspace, `init`
still maps scripts only and says so, naming the richer path:
`bunx @vzn/vx-migrate` (which auto-detects the source) or `plugins: [turbo()]`
from `@vzn/vx-turbo`.

A run in a root with no `vx.workspace.*` at all fails before any task
with `no vx.workspace.ts found — run vx init …` ahead of the usual
`no cache plugin declared` snippet; a file that declares no plugins gets
the plain error, since `init` refuses to overwrite it.

Two npm conventions are mapped rather than copied, because copying them
loses behaviour. `pre<x>` / `post<x>` hooks, which npm runs around `x`
without being named, are folded into `x`'s command in that order
(`prebuild: rimraf dist` + `build: tsc` → `rimraf dist && tsc`), under a
TODO saying so; a `pre<x>` with no `x` stays a task of its own, and
npm's lifecycle hooks (`prepack`, `prepublishOnly`, …) are never tasks.
A script that is nothing but `npm run <other>` (`pnpm <other>`, `yarn
<other>`, `bun run <other>`, `npm test`, `npm start`) becomes a **group**
over `<other>` — `dependsOn` and no command — so the graph runs and
caches the target instead of a package-manager subprocess it cannot
see. Arguments, flags or a `&&` chain make it a real command again and
it is left verbatim.

## `vx migrate`

Moved out of core on 2026-09-10: the Turbo and Nx mappers are
`@vzn/vx-migrate`, their own package, run without a workspace file —

```
bunx @vzn/vx-migrate           # turbo.json or .nx/workspace-data/project-graph.json → vx.config.ts
bunx @vzn/vx-migrate --dry     # print the generated files instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
```

— and `package.json` scripts are `vx init` (above). Typing `vx migrate`
prints that pointer and exits 1. What the package writes reads exactly
like what `vx init` writes: both hand a plan to core's migration seam
(`applyMigration`, exported from `@vzn/vx`), which renders, guards
against overwriting, writes and reports. The mapping rules live in the
package's README.

## `vx show`

Introspect the workspace's **live resolved configs** — what a run
would see right now. Configs load through the same path a run uses,
plugin `config` and `project` stages included, so a package a plugin
gives tasks to (the zero-migration Turbo shape) shows them; cached
evaluations are served from the local cache like a run's. `vx show`
never reads `vx-lock.json` (the lock is already the frozen JSON — open
it directly if you want the frozen view).

```
vx show                          # list every project
vx show <project>                # one project's resolved config
vx show <pkg>#<task>             # a single task
vx show <task>                   # that task in every project declaring it
vx show ... --format json        # machine-readable (default: pretty)
```

No target: one line per project — name, root-relative dir, task count,
and a `(no vx config)` marker for config-less packages; one whose
tasks all come from plugins reads `N tasks (no vx config; from
plugins)`. With `--format json` it's an array of `{ name, dir, tasks:
string[] }`.

```
$ vx show
app   packages/app   3 tasks
bare  packages/bare  (no vx config)
```

`vx show <project>` prints a block per task with every field the run
reads: description, command (`(group)` for group tasks), `dependsOn`,
`timeout`, `retries`, `env.passThrough` / `env.define`, `remote`,
`resources`, `sandbox`, `persistent`, and the cache block
(`inputs.files` / `.workspaceFiles` / `.env` / `.tasks` / `.runtime` /
`.workspaceRuntime`, `outputs.files` / `.workspaceFiles`). Fields the
task does not set are not printed. `--format json` emits `{ name, dir,
config }` with the config exactly as resolved. `vx show <pkg>#<task>`
narrows to one task (`{ name, dir, task, config }` in JSON). A bare
name that is no project is a task: `vx show build` prints the block
from every project declaring `build` (an array of the one-task shape
in JSON).

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

Unknown project / task names exit `1` with the same near-miss hint
every verb gives (two edits, or a partial name); a bare name that is
neither reads `unknown project or task: "buidl" — did you mean build?`.

Exit codes: `0` success; `1` parse error or unknown target.

## `vx info`

Workspace doctor — one screen of facts for bug reports and sanity
checks. The task count comes from the same load a run uses, plugin
stages included; a config that fails to load counts as zero rather
than failing the doctor:

```
$ vx info
vx:                0.0.0
bun:               1.4.0
git:               2.53.0
git status cache:  core.fsmonitor, core.untrackedCache off — `git config core.fsmonitor true` makes every run's status walk near-free on a large tree
workspace root:    /work/repo
projects:       12 (34 tasks)
plugins:        2 — @vzn/vx-reapi (executor, cache); @vzn/vx-otel (telemetry)
cache dir:      /work/repo/.vx/cache
cache versions: keys vx-cache-v27 · index schema v25
cache entries:  42 (1.3 GB)
orphans:        3 artifacts (12.4 MB) the index does not know — `vx cache prune` reaps them
runs (24h):     7 (5 cache hits)
vx-lock.json:   yes
```

- `git` shows `(not found)` when the binary is missing; a broken
  project config contributes zero tasks instead of failing the
  printout.
- `git status cache`: vx runs ONE `git status` per run to find dirty
  and untracked files, and on a large tree that walk is the warm run's
  critical path. git's `core.fsmonitor` (a daemon that watches the
  worktree) and `core.untrackedCache` make it near-free after the first
  run; both are off by default, so `vx info` says when they are.
- `plugins` names every plugin `vx.workspace.*` declares and the seams
  each fills, in pipeline order (`config`, `project`, `graph`, `key`,
  `schedule`, `executor`, `cache`, `telemetry`, `setup`, `commands`),
  or `none`. It reads the declarations: a plugin that declines a task
  at run time still lists its seam here.
- `cache versions` are the two constants a bug report needs and the
  reset notice names: the key prefix (`CACHE_VERSION`; a bump orphans
  every entry) and the index schema (`SCHEMA_VERSION`; a mismatch drops
  every table on the next open, which the run then says once).
- `orphans` appears only when the cache directory holds artifacts or
  save temps the index has no row for, older than an hour (what a
  `SCHEMA_VERSION` reset leaves behind; a fresh one is a save in
  flight). They are never a hit and nothing but `vx cache prune`
  reclaims them, so the doctor says so.
- `--format json` prints the same facts as one typed object, for a
  script or a bug-report template: `vx`, `bun`, `git` (null when not
  found), `gitStatusCache` (`{ fsmonitor, untrackedCache }`, null when
  git could not answer), `workspaceRoot`, `projects`, `tasks`,
  `plugins` (`[{ name, seams }]`), `cacheDir`, `cacheVersion`,
  `schemaVersion`, `cacheEntries`, `cacheBytes`, `orphans`
  (`{ artifacts, bytes }`, always present), `runs24h`, `hits24h`,
  `lockfile`. The pretty rows render this object; there is no second
  source.
- `vx stats` is a **deprecated alias** of `vx info` (info absorbed
  it); it prints byte-identical output.

## `vx why`

Answer "why did this task re-run?" from the terminal, from the
per-component input fingerprints core persists on every miss. Read-only over the local
`cache.db`: no config evaluation, no re-hash.

```
vx why [TASK | PKG#TASK] [--run <runId>] [--format pretty|json] [--cache-dir <path>]
```

By default it compares the task's **latest** recorded run against its
immediately-previous run; `--run <id>` pins a specific run. A bare task
name resolves when exactly one project ran it (several → an error
listing the candidates; unknown → include-match suggestions).

An **unchanged** key has three endings, and the verdict distinguishes
them rather than calling all three a re-run: the run was served from
cache (nothing re-ran), it re-executed on the same key (`--no-cache` /
`--force`, or something outside the key), or it recorded no cache
outcome at all, in which case vx says so instead of guessing.

```
$ vx why app#build
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed between the previous run and this one (inputs differ)

  what changed (1 component, 41 unchanged):
    changed file  src/input.txt  3fe2a1b0… → 91c47d22…
```

The component-level rows come from the `entry_inputs` input
fingerprints persisted with each cache entry; when either side's entry
is gone (pruned, or the run failed and never saved one) the verb still
names the hash change and says the component diff is unavailable. A
task with no `cache` block derives a key too — it is what dependents
fold — but saves no entry, so for it the verb can only report the key
change and says so.
`--format json` emits one machine-readable object (`{ taskId, runId,
why, diff }`).

## `vx prune`

Moved out of core on 2026-09-10: `@vzn/vx-prune` emits a self-contained
SUBSET of the workspace for Docker builds (Turbo `turbo prune` parity)
— one project plus its transitive workspace dependencies, the root
manifests rewritten to the subset, any `vx.workspace.*`, and the
lockfile (unpruned). Two ways in, one body:

```
bunx @vzn/vx-prune <project> [--out-dir <dir>] [--docker]   # no workspace file needed
vx prune <project> [--out-dir <dir>] [--docker]             # when vx.workspace.ts declares prune()
```

```ts
// vx.workspace.ts
import { prune } from '@vzn/vx-prune'
export default { plugins: [prune()] }
```

Typing `vx prune` in a workspace that does not declare it prints that
pointer and exits 1. The rules (what is rewritten, what is excluded,
what `--docker` splits, what the config scan warns about) live in the
package's README. This is the `commands` seam in use: a verb core does
not know, owned by a plugin the workspace declares.

## `vx last`

Replay a recorded run's summary from the local history — no
re-execution, no cache probe, no config evaluation. With the
self-hosted dashboard gone (2026-08-23), this is THE run-replay
surface.

```
vx last [runId] [--list[=N]] [--format pretty|json] [--cache-dir <path>]
```

Bare `vx last` replays the most recent run: a header (verdict, command,
when, duration, branch @ sha, CI, task/hit/failure counts) and a
per-task table — status, id, duration, cache key — failures first.
`vx last --list` prints the N most recent runs (default 10) with their
run ids; `vx last <runId>` replays a specific one. `--format json`
emits `{ invocation, tasks }` for scripting. An unknown run id fails
loud and points at `--list`.

`vx why`, `vx last`, `vx info` and `vx cache prune` all read the cache
a run wrote, so each takes `--cache-dir <path>` with `vx run`'s rules
(cwd-relative, absolute used as-is): a run that wrote its history
elsewhere is replayed, explained, reported on and pruned there. Without
the flag they open the workspace's cache (`defineWorkspace({ cacheDir })`
or `.vx/cache`).

## Plugin commands

A plugin declared in `vx.workspace.ts` can add verbs:

```ts
export function mcp(): VxPlugin {
  return {
    name: 'org/mcp',
    commands: {
      mcp: {
        description: 'serve the run history to an AI agent over stdio',
        async run(argv, ctx) {
          // ctx.workspaceRoot, ctx.cacheDir, ctx.warn(...)
          return 0 // the process exit code
        },
      },
    },
  }
}
```

(`@vzn/vx-mcp` ships exactly this: declare `mcp()` and `vx mcp` serves
five read-only tools to AI agents — four over the run history, one
over the resolved task catalog.) The dispatcher tries core's verbs
first and consults plugins only for a word core does not know, loading
the workspace config from the cwd to find them (outside a workspace the
verb is simply unknown). A plugin verb that names a core verb, or one
two plugins both declare, is refused when the workspace loads — such a
verb could never run, or would hide the other plugin's. A plugin verb's
return value is the exit code, and a thrown `UserError` prints as
cleanly as core's own. `vx help` lists every plugin verb under "Plugin
commands", with the plugin's name.

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
  cache     ▰▰▰▰▰… (miss/no-cache/up-to-date/local/remote meter)
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

## Remote cache (plugin-driven)

Core ships **no remote-cache wire client** — the remote cache is a
plugin concern. A `cache` plugin composes core's `LayeredCache` over a
wire client; `@vzn/vx-reapi` provides one for any Bazel REAPI server
(ActionCache + CAS).

Reads try local first, then remote (hydrating local on remote hit),
with a background prefetch pass overlapping remote GETs with
execution. Writes go to local immediately; the remote upload is a
fire-and-forget background task drained at end of run — failures are
logged via `onRemoteError` but never fail the build.

For any OTHER cache server (a Turbo-wire deployment, S3-direct, …),
implement core's `RemoteCacheLayer` interface in a plugin's `cache`
capability — the recipe lives in the extensibility guide. Embedders
holding a wire client can inject it per-run via
`RunOptions.remoteCache` (explicit injection wins over the plugin
consult). The retired `VX_REMOTE_CACHE_*` env vars are gone.

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
[`caching.md` § SQLite tables](./caching.md#sqlite-tables).

## What's still missing vs Turbo

Tracked in [`comparison.md`](./comparison.md). Nothing visible from the
CLI is open: `--output-logs hash-only`, `@vzn/vx-prune`, `--continue=<mode>`
and `--cache-dir <path>` all shipped and are documented above.
Remote-cache credentials are not core CLI flags at all: core carries no
HTTP cache client — a remote cache arrives through a plugin's `cache`
capability, which owns its own configuration.

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
  graph → cache). What an embedder builds on.
- `defineProject` / `defineWorkspace` — identity helpers for type
  inference in user configs.
- `RunOptions` / `RunSummary` / `TaskOutcome` types are re-exported
  from `@vzn/vx`, alongside the plugin (`VxPlugin`, `TaskExecutor`,
  `CacheLayer`) and telemetry (`TelemetrySink`, `RunSummaryRecord`)
  surfaces — see `src/index.ts`.

A `log: Logger` option lets embedders swap the default framed-block
logger for a custom one (e.g. JSON-line emission). Custom loggers
always see plain text (colors are off when a non-default logger is
provided).

The CLI dispatcher (`run(argv)` in `src/cli/index.ts`) is not part of
the public package exports; `bin.ts` calls it directly.
