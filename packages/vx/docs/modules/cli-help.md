# `src/cli/help.ts` — help text

## Purpose

Static help text printed by `vx help`, `vx --help`, `vx -h`, and the
fall-through after `vx <unknown-command>`; `vx <verb> --help` prints
the same text cut to that verb.

## Public surface

```ts
export function printHelp(pluginCommands?: readonly string[], verb?: string): void
export function helpText(pluginCommands?: readonly string[]): string
export function verbHelpText(verb: string): string
export function documentedFlags(verb: string): string[]
export function seeHelp(verb: string): string
```

`helpText` is the whole reference, hard-coded. `verbHelpText` is the
same text cut to one verb — the title, the `Usage:` lines that name
the verb, and every blank-line-delimited section that is `(for
<verb>)` or lists a `vx <verb>` form — plus a `Full reference: vx
help` trailer; a verb the text does not know gets the whole reference.
There is no second list: the cut reads the text, as `documentedFlags`
(the `(did you mean …)` source) does.

## Sections (current)

- Usage line per subcommand.
- `Selection (for run)` — default / `--all` / `--filter` / `--affected`
  / `pkg#task`.
- `Execution (for run)` — concurrency, `--exclude-dependencies`,
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

`tests/cli.test.ts` pins `verbHelpText`: the run cut carries every
flag `documentedFlags('run')` names and no other verb's section, the
cache and last cuts carry their own examples only, and an unknown verb
gets `helpText()` byte for byte. `tests/cli-doc-drift.test.ts` pins
the run flags table in cli.md against the parser.
