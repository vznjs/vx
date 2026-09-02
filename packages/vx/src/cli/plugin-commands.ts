// Plugin-contributed CLI verbs (`VxPlugin.commands`).
//
// Consulted only when the dispatcher has no core verb for the word: the
// workspace config is loaded from the cwd, and the first plugin (in
// declaration order) declaring the verb runs it. Outside a workspace, or
// with no plugin declaring it, the answer is null and the dispatcher
// reports an unknown command as it always did. Core's verbs are matched
// before this is asked, so a plugin cannot shadow `run`.

import type { VxPlugin, PluginCommand, CommandContext } from '../orchestrator/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'

export interface ResolvedPluginCommand {
  plugin: VxPlugin
  command: PluginCommand
  ctx: CommandContext
}

async function workspacePlugins(
  cwd: string,
): Promise<{ workspaceRoot: string; cacheDir: string; plugins: readonly VxPlugin[] } | null> {
  let workspaceRoot: string
  try {
    workspaceRoot = await findWorkspaceRoot(cwd)
  } catch {
    return null
  }
  const config = await loadWorkspaceConfig(workspaceRoot)
  return {
    workspaceRoot,
    cacheDir: resolveCacheDir(workspaceRoot, config),
    plugins: (config?.plugins ?? []) as readonly VxPlugin[],
  }
}

/** The plugin verb named `verb` for the workspace around `cwd`, or null. */
export async function resolvePluginCommand(
  verb: string,
  cwd = process.cwd(),
): Promise<ResolvedPluginCommand | null> {
  const ws = await workspacePlugins(cwd)
  if (ws === null) return null
  for (const plugin of ws.plugins) {
    const command = plugin.commands?.[verb]
    if (command === undefined) continue
    return {
      plugin,
      command,
      ctx: {
        workspaceRoot: ws.workspaceRoot,
        cacheDir: ws.cacheDir,
        warn: (m) => process.stderr.write(`${m}\n`),
      },
    }
  }
  return null
}

/** `vx help` lines for every plugin verb in the workspace around `cwd`. */
export async function pluginCommandHelp(cwd = process.cwd()): Promise<string[]> {
  const ws = await workspacePlugins(cwd).catch(() => null)
  if (ws === null) return []
  const lines: string[] = []
  const seen = new Set<string>()
  for (const plugin of ws.plugins) {
    for (const [verb, command] of Object.entries(plugin.commands ?? {})) {
      if (seen.has(verb)) continue
      seen.add(verb)
      lines.push(`  vx ${verb.padEnd(17)} ${command.description} (${plugin.name})`)
    }
  }
  return lines
}
