// `bunx @vzn/vx-migrate --from nx`: the resolved graph snapshot on disk,
// through the mapper the `nx()` plugin runs live, as a migration plan.

import path from 'node:path'
import {
  type MigrationFormat,
  type MigrationPlan,
  PERSISTENT_TODO,
  type ProjectMeta,
} from '@vzn/vx'
import { mapNxWorkspace, nxSizeText, parseNxGraph, readNxJson } from './nx/nx-map.js'
import { trackedFiles, trackedKinds } from './tracked-outputs.js'

/** What a task's `npm_package_*` read: the manifest, so a bump reaches them. */
const MANIFEST_IMPORT = "import pkg from './package.json' with { type: 'json' }"

export const NX_GRAPH_REL = '.nx/workspace-data/project-graph.json'

/** `snapshot`: the graph file to read, absolute; the checked-in one by default. */
export async function migrateNx(
  root: string,
  metas: readonly ProjectMeta[],
  format: MigrationFormat = 'ts',
  snapshot = path.join(root, NX_GRAPH_REL),
): Promise<MigrationPlan> {
  const graph = parseNxGraph(await Bun.file(snapshot).text(), path.relative(root, snapshot))
  const tracked = await trackedFiles(root)
  const mapped = await mapNxWorkspace(root, metas, graph, {
    persistentTodo: PERSISTENT_TODO,
    cacheable: new Set(),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    // The file this writes is each task's config.
    ownConfig: () => `vx.config.${format}`,
    manifestField: (key) => ({ raw: `pkg.${key}` }),
    nativeExecutors: true,
  })
  return {
    headerNotes: [
      'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
        'are frozen as static config; an executor target becomes the command its executor ' +
        'runs, or a placeholder the TODOs below list; targets with `.env` files run through ' +
        '`nx-env` (keep @vzn/vx-migrate installed)',
    ],
    projects: mapped.projects.map((p) =>
      p.tasks.some((t) => JSON.stringify(t.task ?? {}).includes('"pkg.'))
        ? { ...p, importLines: [MANIFEST_IMPORT, ...(p.importLines ?? [])] }
        : p,
    ),
    extraFiles: [],
    notes: [...mapped.notes, ...workspaceNotes((await readNxJson(root).catch(() => null))?.json)],
  }
}

/**
 * nx.json's run-wide settings `nx()` applies live and the written
 * `vx.workspace.ts` cannot hold (core writes it): each is a line naming
 * the field to add, or a migrated repo that ran one task at a time for a
 * shared database ran on every core. nx.json only: the files are written
 * for every machine, so `NX_PARALLEL` and friends are not read.
 */
function workspaceNotes(json: Record<string, unknown> | undefined): string[] {
  const nx = json as
    | {
        parallel?: unknown
        tasksRunnerOptions?: { default?: { options?: { parallel?: unknown } } }
        defaultBase?: unknown
        affected?: { defaultBase?: unknown }
        maxCacheSize?: unknown
      }
    | undefined
  const out: string[] = []
  const parallel = nx?.parallel ?? nx?.tasksRunnerOptions?.default?.options?.parallel
  if (typeof parallel === 'number' && Number.isInteger(parallel) && parallel > 0)
    out.push(
      `nx.json \`parallel: ${parallel}\`: add \`concurrency: ${parallel}\` to vx.workspace.ts`,
    )
  const base = nx?.defaultBase ?? nx?.affected?.defaultBase
  if (typeof base === 'string' && base.trim() !== '')
    out.push(
      `nx.json \`defaultBase\` ${JSON.stringify(base.trim())}: add \`affectedBase: ${JSON.stringify(base.trim())}\` to vx.workspace.ts`,
    )
  const size = nxSizeText(nx?.maxCacheSize)
  if (size !== undefined)
    out.push(
      `nx.json \`maxCacheSize\`: add \`cacheRetention: { maxSize: ${JSON.stringify(size)} }\` to vx.workspace.ts`,
    )
  return out
}
