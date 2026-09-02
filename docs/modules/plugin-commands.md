# `src/cli/plugin-commands.ts` — plugin-contributed CLI verbs

## Purpose

The `commands` seam's host. The dispatcher (`cli/index.ts`) matches
core's verbs first; for a word it does not know it asks
`resolvePluginCommand(verb, cwd)`, which finds the workspace around the
cwd, loads `vx.workspace.*`, and returns the first plugin in declaration
order whose `commands[verb]` exists — with a `CommandContext`
(`workspaceRoot`, `cacheDir`, `warn`). `pluginCommandHelp(cwd)` lists
every plugin verb for `vx help`.

## Invariants

- Core's verbs win: a plugin naming `run` or `version` never executes
  (pinned in `tests/plugin-commands.test.ts`).
- Outside a workspace, or with no plugin declaring the verb, the answer is
  `null` and the dispatcher reports "unknown command" as before — never a
  workspace-not-found error for a typo.
- The verb's return value is the process exit code; a thrown `UserError`
  prints like core's own (`bin.ts` handles it).
- The loader validates the shape (`{ description: string, run: function }`)
  before any verb can be reached.

## Tests

`tests/plugin-commands.test.ts`; `@vzn/vx-mcp`'s `tests/server.test.ts`
drives a real plugin verb through the entry point.
