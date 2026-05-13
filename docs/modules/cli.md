# `src/cli.ts` — top-level command dispatcher

## Purpose

Argv → subcommand dispatch. Hand-rolled (no commander / yargs / cac)
to keep the dependency tree slim and behaviour trivially predictable.
Each subcommand handler lives in `src/cli/<name>.ts`.

## Public surface

```ts
export async function run(argv: readonly string[]): Promise<number>

// Re-exports for tests:
export { parseRunArgs, type RunArgs } from './cli/run.js'
export { parsePruneArgs, parseDuration, parseSize } from './cli/cache.js'
export { formatBytes } from './cli/format.js'
```

`run(argv)` returns the exit code. `bin.ts` calls
`process.exit(await run(process.argv.slice(2)))`.

## Subcommands

| Argv first token                     | Handler                                    |
| ------------------------------------ | ------------------------------------------ |
| `run`                                | `cli/run.ts:runCmd(rest)`                  |
| `cache`                              | `cli/cache.ts:cacheCmd(rest)`              |
| `help` / `--help` / `-h` / _(empty)_ | `cli/help.ts:printHelp()`                  |
| `version` / `--version`              | `process.stdout.write('vx <VERSION>\n')`   |
| anything else                        | print `unknown command`, then help, exit 1 |

Per-subcommand parsers / handlers carry their own argv-walk loops.
See:

- [`cli-run.md`](./cli-run.md) — `vx run`
- [`cli-cache.md`](./cli-cache.md) — `vx cache prune`
- [`cli-help.md`](./cli-help.md) — `vx help`
- [`cli-format.md`](./cli-format.md) — shared formatters

## What this does NOT do

- No global flags (no `--debug`, no `--quiet`, no `--color`). Color
  is gated by env (`NO_COLOR` / `FORCE_COLOR` / TTY).
- No tab completion.
- No subcommand aliases beyond the help / version sugar.

## Tests

`tests/cli.test.ts` covers the dispatcher table — help, version,
unknown subcommand. Per-subcommand parser tests live in
`tests/cli.test.ts` too (it's one file).

## Replacing this module

To swap in a parser library, keep `run(argv): Promise<number>` and
keep the per-subcommand re-exports stable (tests import them
directly). Everything else can change.
