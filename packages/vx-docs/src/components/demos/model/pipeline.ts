// The pipeline the Learn pages draw: the architecture page's explorer and
// Mermaid diagram, and the extending page's lit-up strips. One entry per
// hook in core's `PLUGIN_HOOKS`, in its order; `tests/learn-architecture.test.ts`
// holds the list to it both ways. Every render reads this file, so the
// strip, the table, the diagram and the element cannot disagree about the
// stages. Types only from `@vzn/vx`: the site's build never evaluates core.
import type { PluginHook } from '@vzn/vx'

export interface FirstParty {
  /** The call a `vx.workspace.ts` writes. */
  call: string
  pkg: string
  /** The site page that documents it, relative to the site's base. */
  href: string
}

export interface Stage {
  hook: PluginHook
  /** `run`: the stages one run passes through, in order. `lifecycle`: around
   *  the run. `cli`: beside it, for a verb core does not know. */
  group: 'run' | 'lifecycle' | 'cli'
  /** What core does there when no plugin fills the stage. */
  core: string
  /** What a plugin that fills it decides. */
  plugin: string
  firstParty: readonly FirstParty[]
}

const LOCKFILE: FirstParty = {
  call: 'pnpm(), bun(), npm(), yarn()',
  pkg: '@vzn/vx-lockfile',
  href: 'guides/lockfiles/',
}
const HISTORY: FirstParty = {
  call: 'scheduleHistoryPlugin()',
  pkg: '@vzn/vx-schedule-history',
  href: 'guides/plugins/#keys-and-order',
}
const REAPI_CACHE: FirstParty = {
  call: 'reapi()',
  pkg: '@vzn/vx-reapi',
  href: 'guides/remote-caching/',
}

export const STAGES: readonly Stage[] = [
  {
    hook: 'config',
    group: 'run',
    core: 'Reads vx.workspace.ts, then derives the worker count, the cache directory and the default timeout from it.',
    plugin: 'Edits the workspace config before anything is derived from it.',
    firstParty: [],
  },
  {
    hook: 'project',
    group: 'run',
    core: "Loads and validates each project's vx.config.ts. It validates again after each plugin.",
    plugin:
      "Adds, removes or edits a project's tasks, including in a package that has no config file.",
    firstParty: [
      { call: 'turbo()', pkg: '@vzn/vx-migrate', href: 'migrate/from-turborepo/' },
      { call: 'nx()', pkg: '@vzn/vx-migrate', href: 'migrate/from-nx/' },
    ],
  },
  {
    hook: 'graph',
    group: 'run',
    core: 'Expands dependsOn into the task graph, and refuses an edge to a missing task or a cycle.',
    plugin: 'Adds or drops edges, and marks tasks as requested.',
    firstParty: [],
  },
  {
    hook: 'key',
    group: 'run',
    core: "Derives each task's cache key from its config, its declared inputs and its upstream keys.",
    plugin: "Adds named material to one task's key. vx why names it.",
    firstParty: [LOCKFILE],
  },
  {
    hook: 'fingerprint',
    group: 'run',
    core: "Folds every lockfile at the workspace root into every task's key.",
    plugin:
      'Claims a lockfile, so core leaves it out, and says which projects a change to it affects.',
    firstParty: [LOCKFILE],
  },
  {
    hook: 'schedule',
    group: 'run',
    core: 'Starts first the ready task that the most other tasks wait on.',
    plugin: 'Gives tasks weights. Among ready tasks, a higher weight starts first.',
    firstParty: [HISTORY],
  },
  {
    hook: 'admit',
    group: 'run',
    core: 'Runs at most as many tasks at once as there are workers.',
    plugin: 'Holds a ready task back until something that runs here finishes.',
    firstParty: [HISTORY],
  },
  {
    hook: 'executor',
    group: 'run',
    core: 'Runs the command on this machine. The local executor is the last in the list.',
    plugin: 'Runs a task somewhere else, or declines it and hands it back.',
    firstParty: [
      { call: 'reapi({ execute: true })', pkg: '@vzn/vx-reapi', href: 'guides/remote-execution/' },
    ],
  },
  {
    hook: 'cache',
    group: 'run',
    core: 'Stores and restores outputs in the local store, the last layer of the chain.',
    plugin: 'Adds a layer in front of the local store, such as a remote cache.',
    firstParty: [
      REAPI_CACHE,
      { call: 'turboCache()', pkg: '@vzn/vx-migrate', href: 'guides/remote-caching/' },
      { call: 'nxCache()', pkg: '@vzn/vx-migrate', href: 'guides/remote-caching/' },
    ],
  },
  {
    hook: 'telemetry',
    group: 'run',
    core: 'Builds run and task records only when a sink wants them.',
    plugin: 'Receives the records and sends them somewhere. It cannot change the run.',
    firstParty: [
      { call: 'otel()', pkg: '@vzn/vx-otel', href: 'guides/otel-bridge/' },
      { call: 'github()', pkg: '@vzn/vx-github', href: 'guides/ci/' },
    ],
  },
  {
    hook: 'setup',
    group: 'lifecycle',
    core: "Calls it once per run, before any task starts. A throw stops the run with the plugin's name.",
    plugin: 'Validates the workspace, reads a token or opens a connection.',
    firstParty: [],
  },
  {
    hook: 'commands',
    group: 'cli',
    core: "Owns its own verbs. It asks the workspace's plugins about any other verb, in order.",
    plugin: 'Adds verbs to the vx command line.',
    firstParty: [
      { call: 'mcp()', pkg: '@vzn/vx-mcp', href: 'guides/mcp/' },
      { call: 'scheduleHistoryPlugin()', pkg: '@vzn/vx-schedule-history', href: 'guides/plugins/' },
    ],
  },
  {
    hook: 'teardown',
    group: 'lifecycle',
    core: 'Calls it at the end of the run. An error is logged, never thrown.',
    plugin: 'Flushes buffers and closes connections.',
    firstParty: [{ call: 'reapi()', pkg: '@vzn/vx-reapi', href: 'guides/remote-execution/' }],
  },
]

export const RUN_STAGES = STAGES.filter((s) => s.group === 'run')

/** The example plugin for a stage, under `src/examples/`. */
export function stageExample(hook: PluginHook): string {
  return `stages/${hook}.ts`
}

/** Hooks whose value is an object: the signature shows the interface too. */
const OBJECT_HOOK_TYPES: Partial<Record<PluginHook, string>> = {
  fingerprint: 'FingerprintClaim',
  commands: 'PluginCommand',
}

function stripComments(block: string): string[] {
  return block
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
}

function interfaceBody(source: string, name: string): string {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)
  if (m === null) throw new Error(`plugin.ts declares no interface ${name}`)
  return m[1]!
}

/**
 * Each hook's declaration in `VxPlugin`, read from the source of
 * `packages/vx/src/orchestrator/plugin.ts` with its comments removed. The
 * explorer shows these, so the signature on the page is the one core
 * compiles, not a copy of it.
 */
export function hookSignatures(pluginSource: string): Map<string, string> {
  const members = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of stripComments(interfaceBody(pluginSource, 'VxPlugin'))) {
    const start = /^ {2}(?:readonly )?(\w+)\??[(:]/.exec(line)
    if (start !== null) {
      current = []
      members.set(start[1]!, current)
    }
    current?.push(line.slice(2))
  }
  const out = new Map<string, string>()
  for (const [hook, lines] of members) {
    if (hook === 'name') continue
    const type = OBJECT_HOOK_TYPES[hook as PluginHook]
    const extra =
      type === undefined
        ? []
        : ['', `interface ${type} {`, ...stripComments(interfaceBody(pluginSource, type)), '}']
    out.set(hook, [...lines, ...extra].join('\n'))
  }
  return out
}
