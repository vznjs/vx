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
import { definePlugin, type ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace, type TurboMappedProject } from './turbo-map.js'

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
 * scripts at once. The packages are the ones core discovered
 * (`ctx.projects`): walking the workspace again here cost a 1,000-package
 * run a second discovery every time (2026-09-10).
 */
export function turbo(options: TurboPluginOptions = {}): VxPlugin {
  // One mapping per RUN, not per process: the workspace module — and so
  // this plugin instance — outlives a run under `vx watch`, and a mapping
  // memoized for the process ran the cycle after a package.json script
  // edit on the old command (2026-09-10). `ctx.projects` is one array per
  // run, so its identity is the run's.
  let mappedFor: readonly ProjectMeta[] | undefined
  let mapping: Promise<Indexed> | undefined
  let warned = false
  const plugin = definePlugin(import.meta, {
    async project(config: ProjectConfig, ctx) {
      const root = options.root ?? ctx.workspaceRoot
      if (mappedFor !== ctx.projects) {
        mappedFor = ctx.projects
        mapping = mapAll(root, ctx.projects)
        warned = false
      }
      const mapped = await mapping!
      if (!warned) {
        warned = true
        for (const note of mapped.notes) ctx.warn(`[${plugin.name}] ${note}`)
      }
      const project = mapped.byName.get(ctx.name)
      if (project === undefined) return
      config.tasks ??= {}
      for (const t of project.tasks) {
        for (const todo of t.todos) ctx.warn(`[${plugin.name}] ${ctx.name}#${t.name}: ${todo}`)
        if (t.task === null) continue
        // The user's own declaration wins — the plugin fills, never overwrites.
        // A copy per fill: the stage hands core an object it owns and edits
        // in place, and the mapping outlives one run (the watch shape).
        config.tasks[t.name] ??= structuredClone(t.task) as unknown as TaskConfig
      }
    },
  })
  return plugin
}

interface Indexed {
  readonly byName: ReadonlyMap<string, TurboMappedProject>
  readonly notes: readonly string[]
}

/**
 * The mapping indexed by package name. The stage visits every package and
 * each visit looked its package up with a linear scan over the mapping —
 * a million comparisons on a 1,000-package workspace, a third of the
 * stage's cost there (2026-09-10).
 */
async function mapAll(root: string, metas: readonly ProjectMeta[]): Promise<Indexed> {
  const mapped = await mapTurboWorkspace(root, metas, {
    // Inline: the values themselves, where `vx migrate` splices a preset import.
    splice: (_kind, values) => values,
    persistentTodo: PERSISTENT_NOTE,
  })
  const byName = new Map<string, TurboMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, notes: mapped.notes }
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
