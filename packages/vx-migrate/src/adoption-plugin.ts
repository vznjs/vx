// The one shape both adoption plugins have: a `project`-stage plugin over a
// mapping of the whole workspace, computed once per RUN on the first
// package the stage visits and shared by the rest (turbo.json and the Nx
// graph are one source for every package, and a `dependsOn` is only valid
// against all of them at once). `turbo()` and `nx()` each carried this
// skeleton until item 592; what differs is only how the mapping is made.

import { definePlugin, type ProjectHookContext, type TaskConfig, type VxPlugin } from '@vzn/vx'
import { type AdoptionMapping, cachedMapping } from './mapping-cache.js'
import { warnGaps } from './plugin-gaps.js'

/**
 * What a plugin hands the skeleton for one run: every input its mapping
 * reads, as text (the cache key, `mapping-cache.ts`), and the mapping
 * itself, made only when the key has none kept.
 */
export interface AdoptionRun {
  /** The kept mapping's file name: `nx`, `turbo`. */
  readonly name: string
  readonly reads: readonly string[]
  readonly map: () => Promise<AdoptionMapping>
}

/**
 * `mapRun` sees the first visit's context: the workspace root, the cache
 * dir and every package core discovered (`ctx.projects` — walking the
 * workspace again cost a 1,000-package run a second discovery, 2026-09-10).
 */
export function adoptionPlugin(
  meta: ImportMeta,
  mapRun: (ctx: ProjectHookContext) => Promise<AdoptionRun>,
  reads: readonly string[] = [],
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
        mapping = mapRun(ctx).then((r) => cachedMapping(ctx.cacheDir, r.name, r.reads, r.map))
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
    // The root files the mapping reads (`turbo.json`, `nx.json`) shape every
    // task and belong to no project: claimed, so `--affected` selects every
    // project on an edit and `vx watch` re-runs on one (item 961). Which
    // tasks an edit moved would take mapping both sides; every project is
    // the answer a claimant gives when it cannot tell.
    ...(reads.length > 0 ? { fingerprint: { files: reads, affected: () => undefined } } : {}),
  })
  return plugin
}
