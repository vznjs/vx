// `@vzn/vx-migrate` — a Turbo repo under vx with nothing written.
//
// Fills the `project` stage: every package the workspace discovers is given
// the tasks turbo.json + its package.json scripts define, mapped by the same
// mapper `vx migrate --from turbo` renders files from — so what runs here is
// what a migration would have written, minus the file. Turbo's global fields
// are inlined into each task instead of imported from a generated preset.
// A task the package's own vx.config already declares wins; the plugin never
// overwrites a user's hand.

import path from 'node:path'
import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { collectGaps } from '../plugin-gaps.js'
import { mapTurboWorkspace, type TurboMappedProject } from './turbo-map.js'

/** The note every persistent task carries; like every gap, reported once per run for all its tasks. */
const PERSISTENT_NOTE =
  'persistent in turbo.json — vx runs them as persistent tasks that are ready on spawn; ' +
  'add `exec.persistent.readyWhen` in a vx.config to gate dependents on their output'

export interface TurboPluginOptions {
  /**
   * Where turbo.json lives. Defaults to the workspace root; a repo whose
   * turbo.json sits elsewhere names the directory here.
   */
  readonly root?: string
}

/**
 * The plugin: the adoption skeleton over `mapTurboWorkspace`, one mapping
 * per run (`adoption-plugin.ts` says why).
 */
export function turbo(options: TurboPluginOptions = {}): VxPlugin {
  return adoptionPlugin(
    import.meta,
    (ctx) => run(options.root ?? ctx.workspaceRoot, ctx.projects),
    // At the workspace root only: a claim is a root name (a `root` elsewhere
    // is not claimed; its edits select as any unowned file does).
    options.root === undefined ? ['turbo.json', 'turbo.jsonc'] : [],
  )
}

const textOf = (file: string): Promise<string> =>
  Bun.file(file)
    .text()
    .catch(() => '\0absent')

/**
 * Everything the mapping reads: the root's and each package's
 * `turbo.json` / `turbo.jsonc`, and every package manifest.
 */
async function run(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionRun> {
  const dirs = [root, ...metas.map((m) => m.dir)]
  const configs = await Promise.all(
    dirs.flatMap((d) => ['turbo.json', 'turbo.jsonc'].map((f) => textOf(path.join(d, f)))),
  )
  return {
    name: 'turbo',
    reads: [
      JSON.stringify(dirs),
      ...configs,
      JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson])),
    ],
    map: () => mapAll(root, metas),
  }
}

/**
 * The mapping indexed by package name. The stage visits every package and
 * each visit looked its package up with a linear scan over the mapping —
 * a million comparisons on a 1,000-package workspace, a third of the
 * stage's cost there (2026-09-10).
 */
async function mapAll(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionMapping> {
  const mapped = await mapTurboWorkspace(root, metas, {
    // Inline: the values themselves, where `vx migrate` splices a preset import.
    splice: (_kind, values) => values,
    persistentTodo: PERSISTENT_NOTE,
  })
  const byName = new Map<string, TurboMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, gaps: collectGaps(mapped.projects, mapped.notes) }
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
