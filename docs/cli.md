# CLI reference

The `vzn` binary is installed by `@vzn/run`. All commands are
hand-parsed (no commander/yargs/etc.) in `src/cli.ts`.

## Commands

```
vzn run <task> [--project <name>]... [--concurrency <n>] [--force]
vzn help
vzn version
vzn --help, vzn -h
vzn --version, vzn -v
```

### `vzn run <task>`

Run the named task across every project that declares it (filtered by
`--project` if provided). The orchestrator builds the task graph from
declared `dependsOn` and runs it with caching.

Exit codes:

- `0` — every task finished `success` or `cache-hit`.
- `1` — at least one task ended `failed` or `skipped`.

### `vzn help`, `vzn --help`, `vzn -h`

Print the help message to stdout, exit `0`.

### `vzn version`, `vzn --version`, `vzn -v`

Print `vzn <version>` to stdout, exit `0`.

Unknown commands print a help message + error to stderr and exit `1`.

## Flags

| Flag                            | Type              | Default            | Description                                                                                               |
| ------------------------------- | ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `--project <name>`, `-p <name>` | repeatable string | (all)              | Restrict to specific projects. The task graph still expands through `dependsOn` from the listed projects. |
| `--concurrency <n>`, `-c <n>`   | positive integer  | `os.cpus().length` | Maximum parallel tasks. `1` serializes.                                                                   |
| `--force`, `-f`                 | boolean           | off                | Ignore cache hits and re-run. Cache writes still happen on success.                                       |

## Argv parsing rules

- Positional argument before flags is the task name.
- Flag values are consumed as the next argv item: `-p foo` not `-p=foo`.
- Repeated `--project` accumulates: `-p a -p b` selects `{a, b}`.
- Unknown flags (`--bogus`) exit `1` with a clear error.
- A flag missing its value (`-p` at end of argv) exits `1`.
- A second positional after the task name exits `1`.
- `--concurrency abc` (non-integer or < 1) exits `1`.

## What's NOT in the CLI

Intentionally absent — see `docs/README.md` for the broader scope
discussion:

- Multi-task invocation (`vzn run a b c`)
- Wildcards / patterns (`vzn run 'build:*'`)
- `--filter` query language
- `--dry-run`
- `--continue` (failure isolation is already default)
- Output format flags (`--output-logs none/errors-only/full`)
- Cache management subcommands (`vzn cache clean`)
- Graph introspection (`vzn graph`, `vzn list`)

Most of these are tractable additions; they just haven't been built.

## Internal API

The CLI dispatcher is also exported as `run(argv)` from `src/cli.ts`
(distinct from the orchestrator's `run(options)`). Useful for testing
or programmatic use:

```ts
import { run as cliRun } from '@vzn/run/cli' // not yet re-exported
```

Currently you'd `import { run } from '@vzn/run'` for the _orchestrator_
`run` (programmatic API). The CLI dispatcher is not part of the public
package exports; the `bin.ts` entry calls it directly.
