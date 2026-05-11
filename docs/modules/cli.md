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
  task: string | undefined
  projects: string[]
  concurrency: number | undefined
  force: boolean
  error?: string
}
```

`bin.ts` just imports `run` from `./cli.js`, slices `process.argv`,
and `process.exit(code)`s.

## Commands

The dispatcher recognizes:
- `vzn run <task>` → invoke the orchestrator.
- `vzn help` / `--help` / `-h` → print help text.
- `vzn version` / `--version` / `-v` → print `vzn <VERSION>`.
- anything else → print "unknown command", print help, exit 1.

See [`../cli.md`](../cli.md) for the user-facing CLI reference.

## Argv parsing rules

Implemented as a small loop in `parseRunArgs`:

- The first non-flag positional is the task name.
- Flags take their value as the next argv entry:
  - `-p, --project <name>` (repeatable)
  - `-c, --concurrency <n>` (positive integer required)
  - `-f, --force` (boolean)
- Unknown flag → error.
- Missing flag value → error.
- Second positional argument → error.
- Bad concurrency value (NaN, < 1) → error.

All errors are returned as `{ error: '...' }` from `parseRunArgs` and
surface as exit code 1 from `run()`.

## Why hand-rolled

No commander / yargs / cac. The parsing surface is small (4 flags),
hand-rolling keeps the dependency tree slim and the behavior trivially
predictable.

## What this does NOT do

- No global flags (no `--debug`, no `--quiet`, no `--color`).
- No subcommands other than `run`/`help`/`version`.
- No `--` separator handling — extra args after `--` are not forwarded
  to tasks. Tasks read their args from the shell command they declare.
- No tab completion.
- No interactive prompts.

## Tests

`cli.test.ts` covers:
- Help, version, unknown command, missing task name, parser errors
  (unknown flag, missing value, bad concurrency, double positional).
- `parseRunArgs` direct behavior across all flags.
- End-to-end through a real fixture workspace: success exits 0,
  failing task exits 1, `--project` + `--concurrency` flow through to
  the orchestrator.

## Replacing this module

If you want a fancier CLI:

- **Add a parser library** like `cac` (small, ergonomic) or `commander`
  (larger, more features). Keep `parseRunArgs` returning a stable
  shape so tests don't churn.
- **Subcommands** — `vzn cache clean`, `vzn graph`, `vzn affected`.
  Add to the `switch (command)` in `run()`.
- **TUI** — different concern; keep the parser intact and replace the
  `Logger` impl the orchestrator receives.

The `bin.ts` entry should stay tiny — its only job is wiring
`process.argv` and `process.exit`.
