// The `graph` stage as a run applies it, shared by `prepareRun` and the
// CLI's `--affected` task selection (`vx show <task> --affected`), so both
// select over the graph the hooks leave.

import path from 'node:path'
import type { GraphRules, TaskNode } from '../graph/index.js'
import { relPosix, UserError } from '../util/index.js'
import { type ProjectMeta, validateProjectConfig } from '../workspace/index.js'
import { applyGraphHooks } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'
import { isDefaultBuild } from '../graph/index.js'

export async function applyGraphStage(
  plugins: readonly VxPlugin[],
  nodes: Map<string, TaskNode>,
  args: {
    workspaceRoot: string
    cacheDir: string
    projectMetas: readonly ProjectMeta[]
    warn: (message: string) => void
    rules?: GraphRules | undefined
  },
): Promise<void> {
  // A hook edits each node's config in place, as `project` does, so the
  // edit is held to what the loader accepts from a user: a misspelled
  // `exec` field ran as an empty command and failed with no reason.
  const configPaths = new Map(args.projectMetas.map((m) => [m.name, m.configPath]))
  // A node under a directory no project owns, or another project's, ran,
  // keyed and cleaned its outputs there: past the hard project boundary.
  const dirs = new Map(args.projectMetas.map((m) => [m.name, path.resolve(m.dir)]))
  const shown = (dir: string): string => relPosix(args.workspaceRoot, dir) || '.'
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
        const dir = dirs.get(n.projectName)
        if (dir === undefined) {
          throw new UserError(
            `plugin '${plugin.name}' failed in graph: ${n.id}'s project ${n.projectName} is not a project in this workspace`,
          )
        }
        if (path.resolve(n.projectDir) !== dir) {
          throw new UserError(
            `plugin '${plugin.name}' failed in graph: ${n.id}'s projectDir is ${shown(n.projectDir)}, not project ${n.projectName}'s directory ${shown(dir)}`,
          )
        }
        if (isDefaultBuild(n.config)) continue
        const own = configPaths.get(n.projectName) ?? null
        validateProjectConfig(
          { tasks: { [n.taskName]: n.config } },
          `${own ?? `${n.projectName} (no config file)`} (after plugin '${plugin.name}')`,
          own,
        )
      }
    },
    args.rules,
  )
}
