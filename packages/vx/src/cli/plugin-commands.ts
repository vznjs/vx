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
import type {
  BranchFacts,
  VxPlugin,
  PluginCommand,
  CommandContext,
  CacheFacts,
  TaskArtifacts,
} from '../orchestrator/index.js'
import { configuredBaseBranch, findWorkspaceRoot } from '../workspace/index.js'
import { machineParallelism, maskedLine, SecretBroker } from '../util/index.js'
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
      branch: BranchFacts
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
    branch: ws.branch,
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
    // Own keys only: `vx toString` found Object.prototype's and crashed.
    const commands = plugin.commands
    if (commands === undefined || !Object.hasOwn(commands, verb)) continue
    const command = commands[verb]!
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
        artifacts: lazyArtifacts(() => verbArtifacts(ws)),
        artifactsFor: (facts) => lazyArtifacts(() => verbArtifacts(ws, facts)),
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
  const [{ Cache, pluginCache }, { cacheRefs, openRemotes, resolveCache, resolveCacheScope }] =
    await Promise.all([import('../cache/index.js'), import('../orchestrator/index.js')])
  const scope = resolveCacheScope(
    ws.workspaceRoot,
    ws.branch.trusted === true ? null : ws.branch.scope,
    ws.plugins.some((p) => p.cache !== undefined),
    configuredBaseBranch(ws.workspaceConfig),
  )
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
    refs: cacheRefs(ws.workspaceRoot, configuredBaseBranch(ws.workspaceConfig), ws.branch.refs),
    localCache,
    policy: VERB_POLICY,
    remotes,
  })
  await openVerbRemotes(remotes, openRemotes)
  return pluginCache(plugin, { db: localCache.dbHandle(), policy: VERB_POLICY, remotes, scope })
}

/**
 * The verb's `ctx.artifacts`: the workspace's cache as a run opens it, its
 * policy and scope, a laptop writing no remote unless the policy names it.
 * With `facts` (`ctx.artifactsFor`), under another run's refs and lent access.
 */
async function verbArtifacts(
  ws: Exclude<Awaited<ReturnType<typeof workspacePlugins>>, UnresolvedPluginCommand | null>,
  facts?: () => CacheFacts | undefined,
): Promise<TaskArtifacts> {
  const [
    { Cache, FULL_CACHE_POLICY },
    {
      cacheRefs,
      namesRemote,
      openRemotes,
      resolveCache,
      resolveCacheScope,
      taskArtifacts,
      workspaceCachePolicy,
    },
    { onCI },
  ] = await Promise.all([
    import('../cache/index.js'),
    import('../orchestrator/index.js'),
    import('./run.js'),
  ])
  const asked = workspaceCachePolicy(ws.workspaceConfig) ?? FULL_CACHE_POLICY
  const policy: CachePolicy =
    onCI(process.env['CI']) || namesRemote(ws.workspaceConfig?.cache?.policy)
      ? asked
      : { ...asked, remoteWrite: false }
  const scope = resolveCacheScope(
    ws.workspaceRoot,
    ws.branch.trusted === true ? null : ws.branch.scope,
    ws.plugins.some((p) => p.cache !== undefined),
    configuredBaseBranch(ws.workspaceConfig),
  )
  const localCache = new Cache(
    ws.cacheDir,
    { read: policy.localRead, write: policy.localWrite },
    ws.workspaceRoot,
    undefined,
    'open',
    await ws.storeRoot,
  )
  const remotes: ResolvedRemote[] = []
  const cache = await resolveCache(ws.plugins, {
    workspaceRoot: ws.workspaceRoot,
    cacheDir: ws.cacheDir,
    warn,
    scope,
    refs:
      facts?.()?.refs ??
      cacheRefs(ws.workspaceRoot, configuredBaseBranch(ws.workspaceConfig), ws.branch.refs),
    localCache,
    policy,
    remotes,
    ...(facts === undefined ? {} : { lentBy: () => facts()?.lent }),
  })
  await openVerbRemotes(remotes, openRemotes)
  return taskArtifacts(cache, ws.workspaceRoot)
}

/**
 * Each remote's `open`, as a run's: a remote that takes its token there
 * (turboCache's OIDC exchange, a lent token) had none, so an agent's
 * uploads went nowhere and its run could not restore them.
 */
async function openVerbRemotes(
  remotes: readonly ResolvedRemote[],
  open: (typeof import('../orchestrator/index.js'))['openRemotes'],
): Promise<void> {
  const ci = (await import('./run.js')).onCI(process.env['CI'])
  await open(remotes, ci, new SecretBroker(ci, warn))
}

function lazyArtifacts(open: () => Promise<TaskArtifacts>): TaskArtifacts {
  let opened: Promise<TaskArtifacts> | undefined
  const artifacts = (): Promise<TaskArtifacts> => (opened ??= open())
  return {
    save: async (key, task, run) => (await artifacts()).save(key, task, run),
    restore: async (key, task) => (await artifacts()).restore(key, task),
    output: async (key) => (await artifacts()).output(key),
    share: async (key) => (await artifacts()).share(key),
    resend: async (key) => (await artifacts()).resend(key),
  }
}

function lazyCache(open: () => Promise<PluginCache>): PluginCache {
  let opened: Promise<PluginCache> | undefined
  const cache = (): Promise<PluginCache> => (opened ??= open())
  return {
    get: async (key) => (await cache()).get(key),
    put: async (key, bytes) => (await cache()).put(key, bytes),
    has: async (key) => (await cache()).has(key),
    hasMany: async (keys) => (await cache()).hasMany(keys),
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
      lines.push(
        ...helpLines(`  vx ${verb.padEnd(17)} `, `${command.description} (${plugin.name})`),
      )
    }
  }
  return lines
}

/**
 * One help entry: `head` then `text` wrapped at word breaks under the
 * column `head` ends at, at core's reference width, so a plugin's long
 * description reads as core's own entries do.
 */
function helpLines(head: string, text: string, width = 88): string[] {
  const indent = ' '.repeat(head.length)
  const lines: string[] = []
  let line = head
  for (const word of text.split(/\s+/)) {
    const fresh = line === head || line === indent
    if (!fresh && line.length + 1 + word.length > width) {
      lines.push(line)
      line = indent + word
    } else line += fresh ? word : ` ${word}`
  }
  lines.push(line)
  return lines
}
