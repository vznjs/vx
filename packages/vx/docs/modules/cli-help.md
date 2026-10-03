# `src/cli/help.ts` — help text

## Purpose

Static help text printed by `vx help`, `vx --help`, `vx -h` and a bare
`vx` inside a workspace; `vx <verb> --help` prints the same text cut to
that verb. A bare `vx` outside one prints the no-workspace refusal every
verb gives there, pointing at `vx help`, and exits 1; an unknown command
prints one line naming it and pointing at `vx help`, not the text.

## Public surface

```ts
export async function printHelp(
  pluginCommands: readonly string[] = [],
  verb?: string,
): Promise<void>
export function helpColors(
  stream: { isTTY?: boolean },
  detect: (s: NodeJS.WriteStream) => ColorSupport,
): ColorSupport
export function paintHelp(text: string, colors: ColorSupport, paint: typeof Paint): string
export function helpText(pluginCommands: readonly string[] = []): string
export function verbHelpText(verb: string): string
export function documentedFlags(verb: string, text?: string): string[] // text: the help text (default: helpText())
export function seeHelp(verb: string): string
export function flagHint(verb: string, arg: string): string // ` (did you mean --x?)` or '', every verb's unknown-flag refusal
export function acceptedFlags(verb: string): string[] // Usage-line flags; `[OPTIONS]` adds run's, less watch's refusals
export const WATCH_REFUSED_FLAGS: readonly string[]
export { CORE_VERBS } from '../util/index.js'

// `completions.ts`
export type CompletionShell = 'bash' | 'zsh' | 'fish'
export function verbFlags(verb: string): string[] // `--help` + acceptedFlags(verb)
export function completionScript(shell: CompletionShell, verbs: readonly string[]): string
export async function completionsCmd(
  args: readonly string[],
  pluginVerbs: readonly string[],
): Promise<number>

// `core-alias.ts`: registers the `@vzn/vx` virtual module so a
// `vx.config.ts` can import the façade inside the compiled binary,
// where no node_modules copy exists. `bin.ts` calls it before dispatch.
export function registerCoreAlias(load: () => Promise<Record<string, unknown>>): void
```

`helpText` is the whole reference, hard-coded. `verbHelpText` is the
same text cut to one verb — the title, the `Usage:` lines that name
the verb, and every blank-line-delimited section that is `(for
<verb>)` or lists a `vx <verb>` form — plus a `Full reference: vx
help` trailer; a verb the text does not know gets the whole reference.
There is no second list: the cut reads the text, as `acceptedFlags`
(the `(did you mean …)` source, via `flagHint`) does.

`printHelp` paints the text it prints, never the text the parsers read:
`paintHelp` adds accents line by line (headings bold with a dim
`(for <verb>)`, `vx <verb>` bold cyan, the flag, selector or example a
row opens with in cyan; prose and continuation lines plain), so the
painted text strips back to `helpText` byte for byte. `helpColors`
paints on a TTY only, and `NO_COLOR` / `FORCE_COLOR=0` still win:
`FORCE_COLOR=1` set for a CI run's log does not paint a piped help.
A row's term ends at two spaces, so every option row keeps a two-space
gap before its description.

## Sections (current)

- `Usage` — one line per verb.
- `Selection (for run)` — default / `--all` / `--filter` / `--affected`
  / `pkg#task`.
- `Execution (for run)` — concurrency, `--exclude-dependencies`,
  `--no-cache` / `--force`, `--cache`, `--continue`, `--retry`,
  `--timeout`, `--frozen`, `--output-logs`, `--verbosity`.
- `Planning (for run — skips execution)` — `--dry`, `--graph`.
- `Artifacts (for run)` — `--summarize`, `--profile`, `--report`,
  `--report-file`, `--tag`.
- `Extensions (plugins)` — what plugins are for (remote cache,
  distributed execution, telemetry) and the plugin guide's URL.
- `Turbo and Nx spellings (for run)` — what `turbo run` / `nx run-many` flags do here; the table is cli.md § Turbo and Nx flags.
- `Argument forwarding (for run)` — explanation of `--`.
- `Watch mode` — `vx watch`.
- `Cache management` — `vx cache prune` examples.
- `Introspection` — `vx show`, `vx info`, `vx why`, `vx last`.
- `Migration` — `vx init` and the pointer to `bunx @vzn/vx-migrate`.
- `Shell completions` — `vx completions bash|zsh|fish`.
- `Config lock` — `vx lock`.

A trailing `Plugin commands:` section follows, only when the
workspace's plugins add a verb: each verb, its description and its
plugin.

## Updating

When adding / changing a flag in `cli/run.ts` or `cli/cache.ts`,
update the help text here too. `tests/cli-doc-drift.test.ts` holds
the help to the parser: every flag `parseRunArgs` accepts appears in
`help.ts`, so a flag added to the parser and not to the text fails the
gate.

## Tests

`tests/cli.test.ts` pins `verbHelpText`: the run cut carries every
flag `documentedFlags('run')` names and no other verb's section, the
cache and last cuts carry their own examples only, and an unknown verb
gets `helpText()` byte for byte. `tests/cli-doc-drift.test.ts` pins
the run flags table in cli.md against the parser.
