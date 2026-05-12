# CLI reference

The `vx` binary is installed by `@vzn/vx`. All commands are
hand-parsed (no commander/yargs/etc.) in `src/cli.ts`.

## Commands

```
vx run [OPTIONS] [TASK | PKG#TASK] [-- forwarded-args...]
vx stats
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
and skipped tasks. Exits `1` if not inside a pnpm workspace.

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

| Flag                             | Type              | Default            | Description                                                                                  |
| -------------------------------- | ----------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `-F <pattern>`, `--filter <pat>` | repeatable string | (none)             | Filter DSL, see above.                                                                       |
| `-r`, `--recursive`              | boolean           | off                | Select every project that declares the task.                                                 |
| `-c <n>`, `--concurrency <n>`    | positive integer  | `os.cpus().length` | Maximum parallel tasks. `1` serializes.                                                      |
| `--ignore-depends-on`            | boolean           | off                | Skip `dependsOn` expansion; run only the explicitly requested tasks.                         |
| `--no-cache`                     | boolean           | off                | Skip cache reads AND writes. Every task runs; nothing is persisted.                          |
| `--cache`                        | boolean           | off                | No-op. Accepted for parity with vite-task. Caching is governed by each task's `cache` block. |
| `-v`, `--verbose`                | boolean           | off                | Print a summary table (task, status, duration) after the run.                                |

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

Intentionally absent — see `docs/README.md` for the broader scope
discussion:

- Multi-task invocation (`vx run a b c`)
- Wildcards in task names (`vx run 'build:*'`)
- `--dry-run`
- `--continue` (failure isolation is already default)
- Output format flags (`--output-logs none/errors-only/full`)
- Cache management subcommands (`vx cache clean`)
- Graph introspection (`vx graph`, `vx list`)

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
