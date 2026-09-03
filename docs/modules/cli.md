# `src/cli/index.ts` — top-level command dispatcher

## Purpose

Argv → subcommand dispatch; the cli module's contract. Hand-rolled
(no commander / yargs / cac) to keep the dependency tree slim and
behaviour trivially predictable. Each subcommand handler lives in a
sibling `src/cli/<name>.ts`.

## Public surface

```ts
export async function run(argv: readonly string[]): Promise<number>

// Re-exports for tests + programmatic embedders:
export { detectFlow, parseRunArgs, type RunArgs } from './run.js'
export { parsePruneArgs, parseDuration, parseSize } from './cache.js'
export { parseLockArgs, type LockArgs } from './lock.js'
export { parseMigrateArgs, type MigrateArgs } from './migrate.js'
export { parseShowArgs, type ShowArgs } from './show.js'
export { parseMcpArgs, type McpArgs } from './mcp.js'
export { handleMcpRequest, listMcpTools, setMcpContext } from './mcp-rpc.js'
export { formatBytes } from './format.js'
```

`run(argv)` returns the exit code. `bin.ts` calls
`process.exit(await run(process.argv.slice(2)))`.

## Subcommands

| Argv first token                     | Handler                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `run`                                | `cli/run.ts:runCmd(rest)`                                               |
| `watch`                              | `cli/watch.ts:watchCmd(rest)`                                           |
| `cache`                              | `cli/cache.ts:cacheCmd(rest)`                                           |
| `lock`                               | `cli/lock.ts:lockCmd(rest)`                                             |
| `migrate`                            | `cli/migrate.ts:migrateCmd(rest)`                                       |
| `init`                               | `cli/migrate.ts:migrateCmd(['--from', 'scripts', ...rest], { init: true })` — the scripts mapping; scaffolds an empty workspace instead of refusing |
| `upgrade`                            | `cli/upgrade.ts:upgradeCmd(rest)`                                       |
| `show`                               | `cli/show.ts:showCmd(rest)`                                             |
| `info` / `stats` (deprecated alias)  | `cli/info.ts:infoCmd(rest)`                                             |
| `why`                                | `cli/why.ts:whyCmd(rest)`                                               |
| `last`                               | `cli/last.ts:lastCmd(rest)`                                             |
| `prune`                              | `cli/prune.ts:pruneCmd(rest)`                                           |
| `help` / `--help` / `-h` / _(empty)_ | `cli/help.ts:printHelp(pluginVerbs)` — plugin verbs listed with their plugin |
| `version` / `--version`              | `process.stdout.write('vx <VERSION>\n')`                                |
| anything else                        | `cli/plugin-commands.ts:resolvePluginCommand` — the workspace's plugins are asked, in order, for a `commands` entry (`vx mcp` from `@vzn/vx-mcp` is one); a verb resolving a non-integer fails naming the plugin; nothing found → `unknown command` (plus why plugin verbs could not be looked up when the workspace file failed to load), then help, exit 1 |

Per-subcommand parsers / handlers carry their own argv-walk loops.
See:

- [`cli-run.md`](./cli-run.md) — `vx run`
- [`cli-watch.md`](./cli-watch.md) — `vx watch`
- [`cli-cache.md`](./cli-cache.md) — `vx cache prune`
- [`cli-help.md`](./cli-help.md) — `vx help`
- [`cli-format.md`](./cli-format.md) — shared formatters
- `vx lock`, `vx migrate` / `vx init`, `vx show` / `vx info`, `vx why`,
  `vx last`, `vx prune`, `vx upgrade`: documented in
  [`../cli.md`](../cli.md); no separate module doc.

## What this does NOT do

- No global flags (no `--debug`, no `--quiet`, no `--color`). Color
  is gated by env (`NO_COLOR` / `FORCE_COLOR` / TTY).
- No tab completion.
- No subcommand aliases beyond the help / version sugar and the
  deprecated `stats` → `info`.
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
keep the per-subcommand re-exports stable (tests import them
directly). Everything else can change.
