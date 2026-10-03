// `bunx @vzn/vx-migrate --from nx`: the resolved graph snapshot on disk,
// through the mapper the `nx()` plugin runs live, as a migration plan.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type MigrationFormat,
  type MigrationPlan,
  PERSISTENT_TODO,
  type ProjectMeta,
} from '@vzn/vx'
import { mapNxWorkspace, nxSizeText, parseNxGraph, readNxJson } from './nx/nx-map.js'
import { trackedFiles, trackedKinds } from './tracked-outputs.js'
import { adoptedToolNotes } from './workspace-notes.js'

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
    migration: true,
  })
  const adopted = await adoptedToolNotes(root, {
    plugin: 'nx',
    config: 'nx.json',
    runner: 'nx',
    keys: (lock) => `Nx keys each project on the npm packages it depends on in ${lock}`,
  })
  const unlisted = await unlistedProjects(root, metas, mapped.projects)
  return {
    headerNotes: [
      'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
        'are frozen as static config; `nx:run-commands` targets are their shell lines, and ' +
        'every other executor runs as itself through `nx-exec` (keep Nx and @vzn/vx-migrate ' +
        'installed until those targets are rewritten as commands); targets with `.env` files ' +
        'run through `nx-env`',
      ...adopted,
    ],
    projects: mapped.projects.map((p) =>
      p.tasks.some((t) => JSON.stringify(t.task ?? {}).includes('"pkg.'))
        ? { ...p, importLines: [MANIFEST_IMPORT, ...(p.importLines ?? [])] }
        : p,
    ),
    extraFiles: unlisted.manifests,
    notes: [
      ...mapped.notes,
      ...unlisted.notes,
      ...workspaceNotes((await readNxJson(root).catch(() => null))?.json),
    ],
  }
}

/**
 * Nx projects no workspace glob lists (an integrated repo's `project.json`
 * libraries): core finds a project only by a listed package.json, so a
 * config written there would never run. Each gets a package.json when it
 * has none, and one note names the globs to add — the root manifest is
 * the user's to edit, and `applyMigration` never overwrites a file.
 */
async function unlistedProjects(
  root: string,
  metas: readonly ProjectMeta[],
  projects: readonly { name: string; dir: string }[],
): Promise<{ manifests: { relPath: string; contents: string }[]; notes: string[] }> {
  const listed = new Set(metas.map((m) => path.resolve(m.dir)))
  const unlisted = projects.filter(
    (p) => path.resolve(p.dir) !== path.resolve(root) && !listed.has(path.resolve(p.dir)),
  )
  if (unlisted.length === 0) return { manifests: [], notes: [] }
  const rels = unlisted.map((p) => path.relative(root, p.dir).split(path.sep).join('/')).sort()
  const manifests: { relPath: string; contents: string }[] = []
  for (const p of unlisted) {
    const file = path.join(p.dir, 'package.json')
    if (
      await stat(file).then(
        () => true,
        () => false,
      )
    )
      continue
    manifests.push({
      relPath: path.relative(root, file).split(path.sep).join('/'),
      contents: `${JSON.stringify({ name: p.name, private: true }, null, 2)}\n`,
    })
  }
  const pnpm = await stat(path.join(root, 'pnpm-workspace.yaml')).then(
    () => true,
    () => false,
  )
  const where = pnpm ? "pnpm-workspace.yaml's `packages`" : 'package.json `workspaces`'
  const wrote = manifests.length > 0 ? ' (a package.json is written where there was none)' : ''
  return {
    manifests,
    notes: [
      `${unlisted.length} Nx project${unlisted.length === 1 ? ' is' : 's are'} in no workspace glob${wrote} — ` +
        `vx finds a project by a package.json the workspace lists: add ${rels.map((r) => JSON.stringify(r)).join(', ')} to ${where}`,
    ],
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
