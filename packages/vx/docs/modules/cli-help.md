# `src/cli/help.ts` — help text

## Purpose

Static help text printed by `vx help`, `vx --help`, `vx -h`, and the
fall-through after `vx <unknown-command>`.

## Public surface

```ts
export function printHelp(): void
```

Writes the help to stdout. No flags or argument handling — the text
is hard-coded and matches the documented surface.

## Sections (current)

- Usage line per subcommand.
- `Selection (for run)` — default / `--all` / `--filter` / `--affected`
  / `pkg#task`.
- `Execution (for run)` — concurrency, `--excludeDependencies`,
  `--no-cache` / `--force`, `--cache`, `--verbosity`.
- `Planning (for run — skips execution)` — `--dry`, `--graph`.
- `Artifacts (for run)` — `--summarize`, `--profile`.
- `Argument forwarding (for run)` — explanation of `--`.
- `Cache management` — `vx cache prune` examples.

## Updating

When adding / changing a flag in `cli/run.ts` or `cli/cache.ts`,
update the help text here too. Tests don't validate this against the
parser; it's a documentation file that happens to be printable.

## Tests

`tests/cli.test.ts` calls `printHelp()` via the dispatcher and
asserts the output starts with `vx —` (smoke test only).
