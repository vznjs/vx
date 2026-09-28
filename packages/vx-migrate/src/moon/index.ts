// `moon()` — a moon workspace under vx with nothing written. Fills the
// `project` stage from `.moon/` and each project's `moon.yml`, through the
// mapper `bunx @vzn/vx-migrate --from moon` renders files from. A task the
// package's own vx.config declares wins; the plugin never overwrites it.

import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { collectGaps } from '../plugin-gaps.js'
import { mapMoonWorkspace, moonReadList, type MoonMappedProject } from './moon-map.js'

const PERSISTENT_NOTE =
  'persistent in moon — vx runs it as a persistent task that is ready on spawn; ' +
  'add `exec.persistent.readyWhen` in a vx.config to gate dependents on its output'

/** The plugin: the adoption skeleton over `mapMoonWorkspace`, one mapping per run. */
export function moon(): VxPlugin {
  // No fingerprint claim: a claim is a root file name, and `.moon/` is a
  // directory; its edits select under --affected as any unowned file does.
  return adoptionPlugin(import.meta, (ctx) => run(ctx.workspaceRoot, ctx.projects))
}

async function run(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionRun> {
  const files = await moonReadList(root, metas)
  const texts = await Promise.all(
    files.map((f) =>
      Bun.file(f)
        .text()
        .catch(() => '\0absent'),
    ),
  )
  return {
    name: 'moon',
    reads: [
      JSON.stringify(files),
      ...texts,
      JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson])),
    ],
    map: () => mapAll(root, metas),
  }
}

async function mapAll(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionMapping> {
  const mapped = await mapMoonWorkspace(root, metas, { persistentTodo: PERSISTENT_NOTE })
  const byName = new Map<string, MoonMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, gaps: collectGaps(mapped.projects, mapped.notes) }
}

export {
  mapMoonWorkspace,
  type MapMoonOptions,
  type MoonMappedProject,
  type MoonMappedTask,
  type MoonMapping,
} from './moon-map.js'
