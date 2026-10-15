// Plugin-contributed CLI verbs (`VxPlugin.commands`).
//
// Consulted only when the dispatcher has no core verb for the word: the
// workspace config is loaded from the cwd, and the first plugin (in
// declaration order) declaring the verb runs it. Outside a workspace, or
// with no plugin declaring it, the answer is null and the dispatcher
// reports an unknown command as it always did. Core's verbs are matched
// before this is asked, so a plugin cannot shadow `run`.

import type { CachePolicy, PluginCache, ResolvedRemote } from '../cache/index.js'
import type { WorkspaceConfig } from '../config.js'
import type { VxPlugin, PluginCommand, CommandContext } from '../orchestrator/index.js'
import { cacheScopeEnvError, findWorkspaceRoot, isCacheScope } from '../workspace/index.js'
import { machineParallelism, maskedLine } from '../util/index.js'
import { resolveSetting } from '../settings.js'

export interface ResolvedPluginCommand {
  plugin: VxPlugin
  command: PluginCommand
  ctx: CommandContext
}

/**
 * No plugin here declares the verb, and these are the verbs they DO declare
 * — the same load that failed to find the verb already knows them, so the
 * "did you mean" and the "where verbs come from" line cost nothing extra.
 * An empty list is a workspace whose plugins declare no verb at all; `null`
 * from the lookup is no workspace.
 */
interface NoPluginCommand {
  declaredVerbs: readonly string[]
}

/**
 * Why a verb could not be looked up: the workspace file failed to load.
 * Surfaced next to "unknown command" rather than as the whole answer — a
 * typo'd verb must still read as a typo, and a real plugin verb must still
 * point at the file that broke it.
 */
export interface UnresolvedPluginCommand {
  loadError: string
}

async function workspacePlugins(cwd: string): Promise<
  | {
      workspaceRoot: string
      cacheDir: string
      storeRoot: Promise<string | null>
      workspaceConfig: WorkspaceConfig | null
      concurrency: number
      plugins: readonly VxPlugin[]
    }
  | UnresolvedPluginCommand
  | null
> {
  let workspaceRoot: string
  try {
    workspaceRoot = await findWorkspaceRoot(cwd)
  } catch {
    return null
  }
  let ws
  try {
    const { loadCliWorkspace } = await import('./workspace-config.js')
    ws = await loadCliWorkspace(workspaceRoot)
  } catch (err) {
    return { loadError: err instanceof Error ? err.message : String(err) }
  }
  return {
    workspaceRoot,
    cacheDir: ws.cacheDir,
    storeRoot: ws.storeRoot,
    workspaceConfig: ws.workspaceConfig,
    // What run.ts takes when no --concurrency is given.
    concurrency:
      (resolveSetting('run.concurrency', ws.workspaceConfig).value as number | undefined) ??
      machineParallelism(),
    plugins: ws.plugins,
  }
}

/**
 * The plugin verb named `verb` for the workspace around `cwd`; the verbs
 * this workspace's plugins do declare when none of them is it; null when
 * there is no workspace; the load error when the workspace file could not
 * say.
 */
export async function resolvePluginCommand(
  verb: string,
  cwd = process.cwd(),
): Promise<ResolvedPluginCommand | NoPluginCommand | UnresolvedPluginCommand | null> {
  const ws = await workspacePlugins(cwd)
  if (ws === null) return null
  if ('loadError' in ws) return ws
  const declaredVerbs = new Set<string>()
  for (const plugin of ws.plugins) {
    for (const declared of Object.keys(plugin.commands ?? {})) declaredVerbs.add(declared)
    const command = plugin.commands?.[verb]
    if (command === undefined) continue
    return {
      plugin,
      command,
      ctx: {
        workspaceRoot: ws.workspaceRoot,
        cacheDir: ws.cacheDir,
        concurrency: ws.concurrency,
        vx: (await import('./upgrade.js')).isCompiledBinary()
          ? [process.execPath]
          : [process.execPath, Bun.main],
        warn,
        cache: lazyCache(() => verbCache(ws, plugin.name)),
      },
    }
  }
  return { declaredVerbs: [...declaredVerbs] }
}

const warn = (m: string): void => {
  process.stderr.write(`${maskedLine(m)}\n`)
}

/** Read-only: a verb reads what runs stored, and only a run's policy may write. */
const VERB_POLICY: CachePolicy = {
  localRead: true,
  localWrite: false,
  remoteRead: true,
  remoteWrite: false,
}

/**
 * The verb's `ctx.cache`: the plugin's entries in the local store, then each
 * remote the workspace's cache plugins supply, under the run's scope. Opened
 * on first use, so a verb that never reads it opens nothing.
 */
async function verbCache(
  ws: Exclude<Awaited<ReturnType<typeof workspacePlugins>>, UnresolvedPluginCommand | null>,
  plugin: string,
): Promise<PluginCache> {
  const [{ Cache, pluginCache }, { resolveCache }] = await Promise.all([
    import('../cache/index.js'),
    import('../orchestrator/index.js'),
  ])
  const envScope = process.env['VX_CACHE_SCOPE'] || undefined
  if (envScope !== undefined && !isCacheScope(envScope)) throw cacheScopeEnvError()
  const scope = envScope ?? ws.workspaceConfig?.cache?.scope
  const localCache = new Cache(
    ws.cacheDir,
    { read: true, write: false },
    ws.workspaceRoot,
    undefined,
    'open',
    await ws.storeRoot,
  )
  const remotes: ResolvedRemote[] = []
  await resolveCache(ws.plugins, {
    workspaceRoot: ws.workspaceRoot,
    cacheDir: ws.cacheDir,
    warn,
    scope,
    localCache,
    policy: VERB_POLICY,
    remotes,
  })
  return pluginCache(plugin, { db: localCache.dbHandle(), policy: VERB_POLICY, remotes, scope })
}

function lazyCache(open: () => Promise<PluginCache>): PluginCache {
  let opened: Promise<PluginCache> | undefined
  const cache = (): Promise<PluginCache> => (opened ??= open())
  return {
    get: async (key) => (await cache()).get(key),
    put: async (key, bytes) => (await cache()).put(key, bytes),
    has: async (keys) => (await cache()).has(keys),
    getRun: async (name) => (await cache()).getRun(name),
  }
}

/** The plugin verbs the workspace around `cwd` declares, in declaration order; none when it does not load. */
export async function pluginVerbs(cwd = process.cwd()): Promise<string[]> {
  const ws = await workspacePlugins(cwd).catch(() => null)
  if (ws === null || 'loadError' in ws) return []
  const verbs = new Set<string>()
  for (const plugin of ws.plugins)
    for (const verb of Object.keys(plugin.commands ?? {})) verbs.add(verb)
  return [...verbs]
}

/** `vx help` lines for every plugin verb in the workspace around `cwd`. */
export async function pluginCommandHelp(cwd = process.cwd()): Promise<string[]> {
  const ws = await workspacePlugins(cwd).catch(() => null)
  if (ws === null || 'loadError' in ws) return []
  // A verb has one owner, a package: the workspace load refuses two packages
  // declaring it, and of one package's plugins the first declared runs.
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
