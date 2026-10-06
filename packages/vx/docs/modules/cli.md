# `src/cli/index.ts` — top-level command dispatcher

## Purpose

Argv → subcommand dispatch; the cli module's contract. Hand-rolled
(no commander / yargs / cac) to keep the dependency tree slim and
behaviour trivially predictable. Each subcommand handler lives in a
sibling `src/cli/<name>.ts`.

## Public surface

```ts
export async function run(argv: readonly string[]): Promise<number>
export { registerBakedPlugins, registerCoreAlias } from './core-alias.js'
export { BAKED_PLUGINS } from './baked.js'
export { isCompiledBinary } from './upgrade.js'
```

Every verb's module, `run` included, and the plugin-verb lookup are
imported when invoked: each pulls in the orchestrator and the workspace
loader. `vx --version` loads the dispatcher alone, 24 ms against 58 ms
when this file re-exported the verbs' parsers (min of 5, 2026-09-30);
`bin.ts` now answers a lone `--version` / `version` from `version.ts`
without the dispatcher or the util barrel: 16.4 ms against 20.1, where
Bun runs a one-line file in 13.7 (min of 15, interleaved, 2026-10-01).
Tests import a parser from its own file (`cli/run.ts`'s `parseRunArgs`).

`run(argv)` returns the exit code. `bin.ts` sets `process.exitCode` to
it and lets the event loop drain — no `process.exit`, no `stdout.end`:
Bun drops what a pipe has not yet taken when `process.exit` follows a
large write (2026-09-15), and on 1.3.11 `stdout.end`'s callback fired
early too (2026-09-20). A verb never calls `process.exit` itself.

## Subcommands

| Argv first token                     | Handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run`                                | `cli/run.ts:runCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `watch`                              | `cli/watch.ts:watchCmd(rest)`; the OS watcher, its poller fallback and the mtime clock are `cli/watch-fs.ts`, the event filters `cli/watch-filter.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cache`                              | `cli/cache.ts:cacheCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lock`                               | `cli/lock.ts:lockCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `init`                               | `cli/init.ts:initCmd(rest)` — the scripts mapping through the migration seam; scaffolds an empty workspace instead of refusing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `upgrade`                            | `cli/upgrade.ts:upgradeCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `show`                               | `cli/show.ts:showCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `info`                               | `cli/info.ts:infoCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `why`                                | `cli/why.ts:whyCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `last`                               | `cli/last.ts:lastCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `completions`                        | `cli/completions.ts:completionsCmd(rest, pluginVerbs)` — a bash / zsh / fish script over the verb table and each verb's help cut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `help` / `--help` / `-h` / _(empty)_ | `cli/help.ts:printHelp(pluginVerbs)` — plugin verbs listed with their plugin; _(empty)_ outside a workspace prints the no-workspace refusal and exits 1; `help <name>` for no verb is refused as `vx <name>` is                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `version` / `--version`              | `process.stdout.write('vx <VERSION>\n')`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| anything else                        | `cli/plugin-commands.ts:resolvePluginCommand` — the workspace's plugins are asked, in order, for a `commands` entry (`vx mcp` from `@vzn/vx-mcp` is one); a verb resolving a non-integer, or throwing anything but a `UserError`, fails naming the plugin; nothing found → a moved or Nx verb's pointer (`run-many`, `affected`), else a task a project declares named with its `vx run` (`cli/task-verb.ts`), else `unknown command`, a near-miss hint when one exists, why plugin verbs could not be looked up when the workspace file failed to load, and a `vx help` pointer, plus a second line naming where a verb can come from when neither hint applies; exit 1 |

Per-subcommand parsers / handlers carry their own argv-walk loops.
See:

- [`cli-run.md`](./cli-run.md) — `vx run`
- [`cli-watch.md`](./cli-watch.md) — `vx watch`
- [`cli-cache.md`](./cli-cache.md) — `vx cache prune`
- [`cli-help.md`](./cli-help.md) — `vx help`
- [`cli-format.md`](./cli-format.md) — shared formatters
- `vx lock`, `vx init`, `vx show` / `vx info`, `vx why`,
  `vx last`, `vx completions`, `vx upgrade`: documented in
  [`../cli.md`](../cli.md); no separate module doc.

## Workspace loading

Every verb that opens the cache or lists plugin verbs resolves the
workspace through `cli/workspace-config.ts:loadCliWorkspace`: the
workspace config with the plugin `config` stage applied, the plugin
list, and the cache dir derived from the staged config. The stage
shapes `cacheDir`, so a verb reading the file raw would open a
directory the run never used. Plugin warnings go to stderr. A plugin
verb the dispatcher could never reach — one naming a core verb, or one
plugins of two packages both declare — is refused by the workspace VALIDATOR
(`validateWorkspace`, against `util/verbs.ts`), so a run refuses it
exactly as a reading verb or the plugin-verb lookup does. `MOVED_VERBS`
there maps a verb a package owns now (`migrate`, `prune`) or that was
removed (`stats`) to its pointer; a plugin may still declare one.

## What this does NOT do

- No global flags (no `--debug`, no `--quiet`, no `--color`). Color
  is gated by env (`NO_COLOR` / `FORCE_COLOR` / TTY).
- No completion installed for you: `vx completions bash|zsh|fish`
  prints the script; sourcing it is the user's.
- No subcommand aliases beyond the help / version sugar (`stats`
  was removed, H-19).
- No service commands — there is no daemon, server or worker verb in
  core and no separate service package (removed 2026-09-02). A plugin
  that wants a verb adds it through `commands`; `vx mcp` is the
  reference.

## Tests

`tests/cli.test.ts` covers the dispatcher table — help, version,
unknown subcommand, and the service-command redirects (each moved
command must NOT report "unknown command"). Per-subcommand parser tests
live alongside.

## Replacing this module

To swap in a parser library, keep `run(argv): Promise<number>` and
keep each verb's parser in its own file (tests import them
directly). Everything else can change.
