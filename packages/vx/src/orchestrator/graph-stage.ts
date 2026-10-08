// The `graph` stage as a run applies it, shared by `prepareRun` and the
// CLI's `--affected` task selection (`vx show <task> --affected`), so both
// select over the graph the hooks leave.

import type { WorkspaceRules } from '../config.js'
import type { TaskNode } from '../graph/index.js'
import { type ProjectMeta, validateProjectConfig } from '../workspace/index.js'
import { applyGraphHooks } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'
import { isDefaultBuild } from './projects.js'

export async function applyGraphStage(
  plugins: readonly VxPlugin[],
  nodes: Map<string, TaskNode>,
  args: {
    workspaceRoot: string
    cacheDir: string
    projectMetas: readonly ProjectMeta[]
    warn: (message: string) => void
    rules?: WorkspaceRules | undefined
  },
): Promise<void> {
  // A hook edits each node's config in place, as `project` does, so the
  // edit is held to what the loader accepts from a user: a misspelled
  // `exec` field ran as an empty command and failed with no reason.
  const configPaths = new Map(args.projectMetas.map((m) => [m.name, m.configPath]))
  await applyGraphHooks(
    plugins,
    nodes,
    {
      workspaceRoot: args.workspaceRoot,
      cacheDir: args.cacheDir,
      warn: args.warn,
      requested: [...nodes.values()].filter((n) => n.requested).map((n) => n.id),
    },
    (plugin) => {
      for (const n of nodes.values()) {
        if (isDefaultBuild(n.config)) continue
        const where = configPaths.get(n.projectName) ?? `${n.projectName} (no config file)`
        validateProjectConfig(
          { tasks: { [n.taskName]: n.config } },
          `${where} (after plugin '${plugin.name}')`,
        )
      }
    },
    args.rules,
  )
}
