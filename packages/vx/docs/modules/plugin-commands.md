# `src/cli/plugin-commands.ts` — plugin-contributed CLI verbs

## Purpose

The `commands` seam's host. The dispatcher (`cli/index.ts`) matches
core's verbs first; for a word it does not know it asks
`resolvePluginCommand(verb, cwd)`, which finds the workspace around the
cwd, loads `vx.workspace.*`, and returns the one plugin whose
`commands[verb]` exists (the load refuses two declaring a verb) — with a `CommandContext`
(`workspaceRoot`, `cacheDir`, `warn`, and `concurrency`, the worker
count a `vx run` there uses without `--concurrency`: the workspace's
`concurrency`, else `machineParallelism()`). `pluginCommandHelp(cwd)` lists
every plugin verb for `vx help`; `pluginVerbs(cwd)` names them for
`vx completions`.

## Public surface

```ts
export interface ResolvedPluginCommand {
  plugin: VxPlugin
  command: PluginCommand
  ctx: CommandContext
}
/** The workspace file failed to load: said beside "unknown command", never instead of it. */
export interface UnresolvedPluginCommand {
  loadError: string
}

export async function resolvePluginCommand(
  verb: string,
  cwd?: string,
): Promise<
  | ResolvedPluginCommand
  | { declaredVerbs: readonly string[] } // no plugin declares it; these are what they do declare
  | UnresolvedPluginCommand
  | null // no workspace
>
export async function pluginVerbs(cwd?: string): Promise<string[]> // declaration order; none when the workspace does not load
export async function pluginCommandHelp(cwd?: string): Promise<string[]>
```

## Invariants

- Core's verbs win: a plugin naming `run` or `version` never executes
  (pinned in `tests/plugin-commands.test.ts`).
- Outside a workspace the answer is `null`; inside one where no plugin
  declares the verb it is `{ declaredVerbs }` (feeding the "did you mean"
  and the where-verbs-come-from line). Either way the dispatcher reports
  "unknown command" — never a workspace-not-found error for a typo. A workspace file that fails to
  load answers `{ loadError }`: the dispatcher still says "unknown
  command" and adds the load error, so a typo reads as a typo and a real
  plugin verb points at the file that broke it.
- The verb's return value is the process exit code; a thrown `UserError`
  prints like core's own (`bin.ts` handles it).
- The loader validates the shape (`{ description: string, run: function }`)
  before any verb can be reached.

## Tests

`tests/plugin-commands.test.ts`; `packages/vx-mcp/tests/server.test.ts`
drives a real plugin verb through the entry point.
