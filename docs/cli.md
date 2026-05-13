# CLI reference

The `vx` binary is installed by `@vzn/vx`. All commands are
hand-parsed (no commander/yargs/etc.) in `src/cli.ts`; each subcommand
handler lives in `src/cli/<name>.ts`.

## Commands

```
vx run [OPTIONS] [TASK | PKG#TASK] [-- forwarded-args...]
vx stats [--json]
vx cache prune [--older-than <duration>] [--max-size <bytes>]
vx help
vx version
vx --help, vx -h
vx --version, vx -V
```

`-v` is reserved for `--verbose`; use `-V` for `--version`.

### `vx run [TASK]`

Run the named task. By default, only the project containing the current
working directory is selected — `dependsOn` still expands so the
project's upstream workspace deps run too. Override the selection with
`-r`, `-F`, or `pkg#task`.

If no task name is given:

- In a TTY: an interactive picker lists every `pkg#task` entry across the
  workspace, prompts for a number, and runs the chosen one.
- Not a TTY: the run exits `1` with `missing task name`.

Exit codes:

- `0` — every task finished `success` or `cache-hit`.
- `1` — at least one task ended `failed` or `skipped`.

### `vx stats`

Print a summary of the local cache:

```
Cache statistics
----------------
Entries:           42
Total size:        5.0 MB
Runs (24h):        100
Hits  (24h):       73  (73.0%)
```

Reads from `.vx/cache/cache.db` (the v10 SQLite index). The "Runs"
and "Hits" counts come from the `runs` table — recorded for every
task at the end of each `vx run`, including cache hits, failures,
and skipped tasks. Exits `1` if not inside a workspace.

`--json` switches to a machine-readable form for CI scripts. No
formatted byte strings; consumers handle rendering. `hitRateLast24h`
is `null` (not `0`) when there's no denominator so "we don't know"
stays distinguishable from "0%".

```
$ vx stats --json
{
  "entryCount": 27,
  "totalBytes": 132032,
  "runCountLast24h": 52,
  "hitCountLast24h": 9,
  "hitRateLast24h": 0.173
}
```

### `vx cache prune`

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

Output:

```
$ vx cache prune --older-than 30d
Pruned 42 entries (1.3 GB freed)
```

Exits `1` on parse error, missing policy, or workspace-discovery error.

### `vx help`, `vx --help`, `vx -h`

Print the help message to stdout, exit `0`.

### `vx version`, `vx --version`, `vx -V`

Print `vx <version>` to stdout, exit `0`.

Unknown commands print a help message + error to stderr and exit `1`.

## Selection

`vx run` picks the set of projects to consider, then walks `dependsOn`
to assemble the full task graph from that set. Pick one of:

| Form                | Effect                                                                |
| ------------------- | --------------------------------------------------------------------- |
| (default)           | The project that contains cwd. Errors if cwd is not inside a project. |
| `pkg#task`          | Just that project.                                                    |
| `-r`, `--recursive` | Every project that declares the task.                                 |
| `-F <pattern>`      | pnpm-style filter DSL (repeatable).                                   |

### Filter DSL (`-F`, `--filter`)

| Form            | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `<pattern>`     | Match by package name. `*` is a wildcard (no `/`).                            |
| `./<dir>`       | Match packages whose dir is at or under `<dir>` (relative to workspace root). |
| `{<dir>}`       | Same as `./<dir>`.                                                            |
| `<pattern>...`  | Match + all transitive workspace dependencies.                                |
| `...<pattern>`  | Match + all transitive workspace dependents.                                  |
| `<pattern>^...` | Only the transitive dependencies, excluding the matched package itself.       |
| `!<pattern>`    | Exclude packages matching `<pattern>`.                                        |

Filters are evaluated in order. If at least one include filter is
present, the base set is empty and matched packages are added. If only
exclude filters are given, the base set is "all projects" minus the
excluded ones.

Examples:

```sh
vx run build -F @scope/*        # all packages under @scope
vx run build -F app...          # app and its transitive deps
vx run build -F ...util         # util and everything that depends on it
vx run build -F app^...         # only app's deps
vx run build -F '*' -F '!docs'  # everything except docs
```

## Argument forwarding (`--`)

Anything after `--` is forwarded (shell-quoted) to the task's `exec.command`:

```sh
vx run test -- --watch              # vitest sees --watch
vx run build -- --sourcemap         # build command gets --sourcemap
```

Forwarded args are folded into the cache key — runs with different
forwarded args never spuriously hit cache.

## Flags

| Flag                             | Type              | Default                         | Description                                                                                  |
| -------------------------------- | ----------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `-F <pattern>`, `--filter <pat>` | repeatable string | (none)                          | Filter DSL, see above.                                                                       |
| `-r`, `--recursive`              | boolean           | off                             | Select every project that declares the task.                                                 |
| `-c <n>`, `--concurrency <n>`    | positive integer  | `navigator.hardwareConcurrency` | Maximum parallel tasks. `1` serializes.                                                      |
| `--ignore-depends-on`            | boolean           | off                             | Skip `dependsOn` expansion; run only the explicitly requested tasks.                         |
| `--no-cache`                     | boolean           | off                             | Skip cache reads AND writes. Every task runs; nothing is persisted; outputs are NOT cleaned. |
| `--cache`                        | boolean           | off                             | No-op. Accepted for parity with vite-task. Caching is governed by each task's `cache` block. |
| `-v`, `--verbose`                | boolean           | off                             | Print a per-task summary table after the framed blocks.                                      |
| `--dry-run`, `--dry`             | boolean           | off                             | Print the planned task graph + predicted cache hit/miss; skip execution.                     |
| `--graph`                        | boolean           | off                             | Print the task graph as Graphviz DOT; skip execution.                                        |
| `--json`                         | boolean           | off                             | With `--dry-run`, emit JSON instead of human text. (No effect alone yet.)                    |

## Planning mode (`--dry-run`, `--graph`)

Both flags short-circuit execution. They build the full task graph,
compute every task's cache key, and probe the cache to predict what
would happen if you ran the same command without the flag.

```
$ vx run ci --dry-run
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
| `○`    | group task (suppressed in the human view; in DOT + JSON)     |

`--dry-run --json` emits the same data as a JSON object for tooling:

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

`--graph` prints Graphviz DOT to stdout. Pipe through `dot` to render:

```
vx run ci --graph | dot -Tsvg > graph.svg
```

Node fillcolor varies by predicted status (green = local hit, sky-blue
= remote hit, orange = miss, gray = no-cache, fuchsia = group).

`--dry-run` and `--graph` are mutually exclusive; passing both errors.

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
... bun test output ...
└─ @vzn/vx#test ── (5.20s) executed

 Tasks:    2 successful, 2 total
Cached:    1 local, 2 total
  Time:    5.34s
```

Top border shows the task id + a status hint (`cache hit • <hash>`,
`remote cache hit • <hash>`, `executed`, `skipped (upstream failed)`,
`$ <command>` on failure). Bottom border always shows the
operation-time (wallclock for the actual work — clean+restore for
cache hits, exec for misses) plus the final status (`executed`, `from
local cache`, `from remote cache`, `FAILED (exit N)` in bold red,
`skipped` in yellow).

When every real task came from cache, the summary's `Time:` line
appends `>>> FULL CACHE` (Turbo's `>>> FULL TURBO` flourish, our
cache).

**Group tasks** (no `exec` — pure `dependsOn` aggregators) emit no
framed block. They're invisible in the run output by design.

### Colors

ANSI truecolor (`ansi-16m`) sequences, gated by env:

| Var             | Effect                        |
| --------------- | ----------------------------- |
| `NO_COLOR=…`    | Force off. Overrides FORCE\_. |
| `FORCE_COLOR=…` | Force on.                     |
| (neither)       | On iff `stdout.isTTY`.        |

Custom loggers passed via the programmatic API always see plain text.

## Argv parsing rules

- `--` separates vx flags from forwarded task args. Everything after
  `--` is appended (shell-quoted) to each task's `exec.command`.
- The positional argument (before `--`) is the task name, optionally
  prefixed with `pkg#`.
- Flag values are consumed as the next argv item: `-F foo` not `-F=foo`.
- Repeated `-F` / `--filter` accumulates.
- Unknown flags exit `1` with a clear error.
- A second positional before `--` exits `1`.
- `--concurrency abc` (non-integer or `< 1`) exits `1`.

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

## What's NOT in the CLI

Intentionally absent — see [`comparison.md`](./comparison.md) for the
full Turbo/Nx/vite-task gap list and which items we'd accept PRs for:

- Multi-task invocation (`vx run a b c`)
- Wildcards in task names (`vx run 'build:*'`)
- `--continue` (failure isolation is already the default for
  independent siblings)
- Output mode flags (`--output-logs none/errors-only/full`)
- Cache management subcommands beyond `prune` (`vx cache clean`)
- `vx graph` / `vx list` as standalone subcommands (the same data is
  available via `vx run <task> --graph` and `--dry-run --json`).
- `affected --base <ref>` (Nx-style git-relative selection)
- Watch / daemon mode

Most of these are tractable additions; they just haven't been built.

## Internal API

The CLI dispatcher is also exported as `run(argv)` from `src/cli.ts`
(distinct from the orchestrator's `run(options)`). Useful for testing
or programmatic use:

```ts
import { run as cliRun } from '@vzn/vx/cli' // not yet re-exported
```

Currently you'd `import { run } from '@vzn/vx'` for the _orchestrator_
`run` (programmatic API). The CLI dispatcher is not part of the public
package exports; the `bin.ts` entry calls it directly.
