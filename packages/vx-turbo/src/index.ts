// `@vzn/vx-turbo` — a Turbo repo under vx with nothing written.
//
// Fills the `project` stage: every package the workspace discovers is given
// the tasks turbo.json + its package.json scripts define, mapped by the same
// mapper `vx migrate --from turbo` renders files from — so what runs here is
// what a migration would have written, minus the file. Turbo's global fields
// are inlined into each task instead of imported from a generated preset.
// A task the package's own vx.config already declares wins; the plugin never
// overwrites a user's hand.

import type { ProjectConfig, TaskConfig, VxPlugin } from '@vzn/vx'
import { listProjectMetas, loadWorkspace, type ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace, type TurboMapping } from './turbo-map.js'

const PLUGIN_NAME = 'vx/turbo'

/** The TODO a persistent task carries in `vx migrate`'s report, in the plugin's voice. */
const PERSISTENT_NOTE =
  'persistent in turbo.json — vx runs it as a persistent task that is ready on spawn; ' +
  'add `exec.persistent.readyWhen` in a vx.config to gate dependents on its output'

export interface TurboPluginOptions {
  /**
   * Where turbo.json lives. Defaults to the workspace root; a repo whose
   * turbo.json sits elsewhere names the directory here.
   */
  readonly root?: string
}

/**
 * The plugin. One mapping per run, computed on the first project the stage
 * visits and shared by the rest — turbo.json is one file for the whole
 * workspace, and a task's `dependsOn` is only valid against every package's
 * scripts at once.
 */
export function turbo(options: TurboPluginOptions = {}): VxPlugin {
  let mapping: Promise<TurboMapping> | undefined
  let warned = false
  return {
    name: PLUGIN_NAME,
    async project(config: ProjectConfig, ctx) {
      const root = options.root ?? ctx.workspaceRoot
      mapping ??= mapAll(root)
      const mapped = await mapping
      if (!warned) {
        warned = true
        for (const note of mapped.notes) ctx.warn(`[${PLUGIN_NAME}] ${note}`)
      }
      const project = mapped.projects.find((p) => p.name === ctx.name)
      if (project === undefined) return
      config.tasks ??= {}
      for (const t of project.tasks) {
        for (const todo of t.todos) ctx.warn(`[${PLUGIN_NAME}] ${ctx.name}#${t.name}: ${todo}`)
        if (t.task === null) continue
        // The user's own declaration wins — the plugin fills, never overwrites.
        // A copy per fill: the stage hands core an object it owns and edits
        // in place, and the mapping outlives one run (the watch shape).
        config.tasks[t.name] ??= structuredClone(t.task) as unknown as TaskConfig
      }
    },
  }
}

async function mapAll(root: string): Promise<TurboMapping> {
  const workspace = await loadWorkspace(root)
  const metas: ProjectMeta[] = await listProjectMetas(workspace)
  return await mapTurboWorkspace(root, metas, {
    // Inline: the values themselves, where `vx migrate` splices a preset import.
    splice: (_kind, values) => values,
    persistentTodo: PERSISTENT_NOTE,
  })
}

// The mapper itself, for tools that render what this plugin runs live
// (`@vzn/vx-migrate` writes it to files).
export {
  mapTurboWorkspace,
  type MapTurboOptions,
  type TurboGlobal,
  type TurboMappedProject,
  type TurboMappedTask,
  type TurboMapping,
} from './turbo-map.js'
