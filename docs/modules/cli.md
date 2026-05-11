# `cli.ts` and `bin.ts` — command-line dispatcher

## Purpose

Hand-written argv parser and command dispatcher. `bin.ts` is the
binary entry that calls `cli.run()` and exits with its code; `cli.ts`
is the testable function.

## Public surface

```ts
// cli.ts
export async function run(argv: readonly string[]): Promise<number>
export function parseRunArgs(args: readonly string[]): RunArgs

interface RunArgs {
  task: string | undefined // task or `pkg#task`
  filters: string[] // raw -F values
  recursive: boolean // -r
  ignoreDependsOn: boolean // --ignore-depends-on
  concurrency: number | undefined // -c
  noCache: boolean // --no-cache
  forwardArgs: string[] // everything after `--`
  verbose: boolean // -v / --verbose
  error?: string
}
```

`bin.ts` just imports `run` from `./cli.js`, slices `process.argv`,
and `process.exit(code)`s.

## Commands

- `vzn run [OPTIONS] [TASK | PKG#TASK] [-- forwarded-args...]`
- `vzn help` / `--help` / `-h`
- `vzn version` / `--version` / `-V`
- anything else → print "unknown command", print help, exit 1.

Note: `-v` is reserved for `--verbose`; `--version` shorthand is `-V`.

See [`../cli.md`](../cli.md) for the user-facing CLI reference.

## Selection model

After `parseRunArgs`, the dispatcher resolves the project set:

| Input                    | Resolution                                      |
| ------------------------ | ----------------------------------------------- |
| `pkg#task` task argument | `projects = [pkg]`                              |
| `-r` / `--recursive`     | `projects = undefined` (orchestrator picks all) |
| `-F` filter(s)           | `projects = applyFilters(...)` via `filter.ts`  |
| (default)                | resolve cwd → enclosing project; error if none  |

`pkg#task` and `-F` both still expand through `dependsOn`. The orchestrator
treats `projects` as a starting set, not a final set.

## Interactive picker

If the task argument is missing AND stdin is a TTY, the CLI loads every
`pkg#task` declared in the workspace, prints a numbered list, and reads
a selection via `readline/promises`. If stdin is not a TTY, the CLI
exits `1` with `missing task name`.

## Argument forwarding (`--`)

`parseRunArgs` splits argv on the first `--`. Everything before is
parsed as flags + task; everything after is verbatim `forwardArgs`,
passed through the orchestrator to the last `exec` step of each task,
shell-quoted by `runner.ts:shellQuote`.

`forwardArgs` is folded into the cache key — different forwarded args
never spuriously hit cache.

## Argv parsing rules

Implemented as a small loop in `parseRunArgs`:

- The first non-flag positional (before `--`) is the task name.
- Flags take their value as the next argv entry:
  - `-F, --filter <pattern>` (repeatable)
  - `-c, --concurrency <n>` (positive integer)
  - `-r, --recursive` (boolean)
  - `--ignore-depends-on` (boolean)
  - `--no-cache` (boolean)
  - `--cache` (no-op, parity with vite-task)
  - `-v, --verbose` (boolean)
- Unknown flag → error.
- Missing flag value → error.
- Second positional → error.
- Bad concurrency value (NaN, `< 1`) → error.

All errors are returned as `{ error: '...' }` from `parseRunArgs` and
surface as exit code 1 from `run()`.

## Why hand-rolled

No commander / yargs / cac. The parsing surface is small,
hand-rolling keeps the dependency tree slim and the behavior trivially
predictable.

## What this does NOT do

- No global flags (no `--debug`, no `--quiet`, no `--color`).
- No subcommands other than `run`/`help`/`version`.
- No tab completion.
- No multi-task invocation (`vzn run a b c`).

## Tests

`cli.test.ts` covers:

- Help, version (both `--version` and `-V`), unknown command, missing
  task name, parser errors (unknown flag, missing value, bad
  concurrency, double positional).
- `parseRunArgs` direct behavior across all flags including `--`
  separator and forwarding semantics.
- End-to-end through a real fixture workspace: default cwd resolution,
  `-r` recursive, `pkg#task` addressing, `-F` filter, no-match errors,
  `-v` verbose summary, arg forwarding to the underlying command.

## Replacing this module

- **Different parser library** — keep `parseRunArgs` returning a stable
  shape so tests don't churn.
- **Subcommands** — `vzn cache clean`, `vzn graph`, `vzn affected`. Add
  to the `switch (command)` in `run()`.
- **Different filter DSL** — replace `filter.ts`, keep its two exports.
- **TUI** — different concern; keep the parser intact and replace the
  `Logger` impl the orchestrator receives.

The `bin.ts` entry should stay tiny — its only job is wiring
`process.argv` and `process.exit`.
