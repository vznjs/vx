// The one shape both adoption plugins have: a `project`-stage plugin over a
// mapping of the whole workspace, computed once per RUN on the first
// package the stage visits and shared by the rest (turbo.json and the Nx
// graph are one source for every package, and a `dependsOn` is only valid
// against all of them at once). `turbo()` and `nx()` each carried this
// skeleton until item 592; what differs is only how the mapping is made.

import { definePlugin, type ProjectHookContext, type TaskConfig, type VxPlugin } from '@vzn/vx'
import { type Gaps, warnGaps } from './plugin-gaps.js'

/** What a mapping hands the stage: tasks per package name, and the gaps to report once. */
export interface AdoptionMapping {
  readonly byName: ReadonlyMap<
    string,
    {
      readonly tasks: readonly {
        readonly name: string
        readonly task: Record<string, unknown> | null
      }[]
    }
  >
  readonly gaps: Gaps
}

/**
 * `mapRun` sees the first visit's context: the workspace root, the cache
 * dir and every package core discovered (`ctx.projects` — walking the
 * workspace again cost a 1,000-package run a second discovery, 2026-09-10).
 */
export function adoptionPlugin(
  meta: ImportMeta,
  mapRun: (ctx: ProjectHookContext) => Promise<AdoptionMapping>,
): VxPlugin {
  // One mapping per RUN, not per process: the workspace module — and so
  // this plugin instance — outlives a run under `vx watch`, and a mapping
  // memoized for the process ran the cycle after a package.json script
  // edit on the old command (2026-09-10). `ctx.projects` is one array per
  // run, so its identity is the run's.
  let mappedFor: ProjectHookContext['projects'] | undefined
  let mapping: Promise<AdoptionMapping> | undefined
  let warned = false
  const plugin = definePlugin(meta, {
    async project(config, ctx) {
      if (mappedFor !== ctx.projects) {
        mappedFor = ctx.projects
        mapping = mapRun(ctx)
        warned = false
      }
      const mapped = await mapping!
      if (!warned) {
        warned = true
        warnGaps(ctx.warn, plugin.name, mapped.gaps)
      }
      const project = mapped.byName.get(ctx.name)
      if (project === undefined) return
      config.tasks ??= {}
      for (const t of project.tasks) {
        if (t.task === null) continue
        // The user's own declaration wins — the plugin fills, never overwrites.
        // The mapping's own object, not a copy: the mapping is made per RUN
        // (above), so nothing outlives the run that fills from it, and core
        // only reads a stage-given task after validating it. The copy was
        // the per-process memo's guard and cost 10 ms per run at 1,000
        // projects, 3,000 clones (item 609).
        config.tasks[t.name] ??= t.task as unknown as TaskConfig
      }
    },
  })
  return plugin
}
