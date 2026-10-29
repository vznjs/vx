// `bunx @vzn/vx-migrate --from nx`: the resolved graph snapshot on disk,
// through the mapper the `nx()` plugin runs live, as a migration plan.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type GeneratedProject,
  type MigrationFormat,
  type MigrationPlan,
  quoteTsLiteral,
} from '@vzn/vx'
import type { PackageMeta } from './packages.js'
import { mapNxWorkspace, parseNxGraph, readNxJson } from './nx/nx-map.js'
import { spareTrackedOutputs, trackedFiles, trackedKinds } from './tracked-outputs.js'
import { adoptedToolNotes } from './workspace-notes.js'
import { relPosix } from './paths.js'

/** What a task's `npm_package_*` read: the manifest, so a bump reaches them. */
const MANIFEST_IMPORT = "import pkg from './package.json' with { type: 'json' }"

export const NX_GRAPH_REL = '.nx/workspace-data/project-graph.json'

/** `snapshot`: the graph file to read, absolute; the checked-in one by default. */
export async function migrateNx(
  root: string,
  metas: readonly PackageMeta[],
  format: MigrationFormat = 'ts',
  snapshot = path.join(root, NX_GRAPH_REL),
  /** This run writes `.vx/workspace.ts`, with nx.json's run settings as fields. */
  writesWorkspace = false,
  /** No package.json anywhere: each config names its project and holds every edge. */
  bare = false,
): Promise<MigrationPlan> {
  const graph = parseNxGraph(await Bun.file(snapshot).text(), path.relative(root, snapshot))
  const tracked = await trackedFiles(root)
  const mapped = await mapNxWorkspace(root, metas, graph, {
    cacheable: new Set(),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    // The file this writes is each task's config.
    ownConfig: () => `vx.config.${format}`,
    manifestField: (key) => ({ raw: `pkg.${key}` }),
    migration: true,
  })
  // A reader whose `!` hides a committed file under another task's output
  // runs uncached, as under nx().
  if (tracked !== null)
    for (const [id, todo] of spareTrackedOutputs(root, mapped.projects, tracked)) {
      const at = id.lastIndexOf('#')
      const p = mapped.projects.find((x) => x.name === id.slice(0, at))
      p?.tasks.find((t) => t.name === id.slice(at + 1))?.todos.push(todo)
    }
  const adopted = await adoptedToolNotes(root, {
    plugin: 'nx',
    config: 'nx.json',
    runner: 'nx',
    keys: (lock) => `Nx keys each project on the npm packages it depends on in ${lock}`,
  })
  const unlisted = bare
    ? { manifests: [], notes: bareNotes(mapped.projects) }
    : await unlistedProjects(root, metas, mapped.projects)
  if (bare) for (const p of mapped.projects) explicitOnly(p)
  return {
    headerNotes: [
      bare
        ? 'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
          'are frozen as static config; `nx:run-commands` targets are their shell lines'
        : 'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
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
      ...nxWorkspaceFields((await readNxJson(root).catch(() => null))?.json)
        .filter((f) => !writesWorkspace || f.source === undefined)
        .map((f) => f.note),
    ],
  }
}

/**
 * A project with no manifest is named by its path unless its config names
 * it, and a `^` edge follows the lockfile plugin's package edges, which a
 * repo with no package.json has none of: the config keeps Nx's name, and
 * the explicit edges the mapper drew from Nx's graph are every edge.
 */
function explicitOnly(p: GeneratedProject): void {
  p.writeName = true
  for (const t of p.tasks) {
    const deps = t.task?.['dependsOn']
    if (!Array.isArray(deps)) continue
    const kept = deps.filter((d) => typeof d !== 'string' || !d.startsWith('^'))
    // A group keeps its list, as `dropUnheldDeps` keeps one.
    if (kept.length > 0 || t.task!['exec'] === undefined) t.task!['dependsOn'] = kept
    else delete t.task!['dependsOn']
  }
}

/** `nx-exec` and `nx-env` are this package's bins, and a repo with no package.json cannot install it. */
function bareNotes(projects: readonly GeneratedProject[]): string[] {
  const ids = projects.flatMap((p) =>
    p.tasks.flatMap((t) => {
      const cmd = (t.task?.['exec'] as { command?: unknown } | undefined)?.command
      return typeof cmd === 'string' && /^nx-(exec|env) /.test(cmd) ? [`${p.name}#${t.name}`] : []
    }),
  )
  if (ids.length === 0) return []
  return [
    `${ids.join(', ')} run${ids.length === 1 ? 's' : ''} through nx-exec or nx-env, @vzn/vx-migrate's bins, which a repo with no package.json cannot install: rewrite ${ids.length === 1 ? 'it' : 'them'} as commands`,
  ]
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
  metas: readonly PackageMeta[],
  projects: readonly { name: string; dir: string }[],
): Promise<{ manifests: { relPath: string; contents: string }[]; notes: string[] }> {
  const listed = new Set(metas.map((m) => path.resolve(m.dir)))
  const unlisted = projects.filter(
    (p) => path.resolve(p.dir) !== path.resolve(root) && !listed.has(path.resolve(p.dir)),
  )
  if (unlisted.length === 0) return { manifests: [], notes: [] }
  const rels = unlisted.map((p) => relPosix(root, p.dir)).sort()
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
      relPath: relPosix(root, file),
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

/** A `.vx/workspace.ts` field nx.json's run settings call for. */
export interface NxWorkspaceField {
  /** The setting's path: its group, then its field, or a top-level key. */
  readonly field: 'run.concurrency' | 'baseBranch'
  /** The value as TypeScript source; undefined when vx cannot read it. */
  readonly source: string | undefined
  /** What to tell a user whose workspace file this run does not write. */
  readonly note: string
}

/**
 * nx.json's run-wide settings `nx()` applies live: each a field of the
 * written `.vx/workspace.ts`, or a migrated repo that ran one task at a time
 * for a shared database ran on every core. nx.json only: the files are
 * written for every machine, so `NX_PARALLEL` and friends are not read.
 */
export function nxWorkspaceFields(json: Record<string, unknown> | undefined): NxWorkspaceField[] {
  const nx = json as
    | {
        parallel?: unknown
        tasksRunnerOptions?: { default?: { options?: { parallel?: unknown } } }
        defaultBase?: unknown
        affected?: { defaultBase?: unknown }
      }
    | undefined
  const out: NxWorkspaceField[] = []
  const parallel = nx?.parallel ?? nx?.tasksRunnerOptions?.default?.options?.parallel
  if (typeof parallel === 'number' && Number.isInteger(parallel) && parallel > 0)
    out.push({
      field: 'run.concurrency',
      source: String(parallel),
      note: `nx.json \`parallel: ${parallel}\`: add \`run: { concurrency: ${parallel} }\` to .vx/workspace.ts`,
    })
  const base = nx?.defaultBase ?? nx?.affected?.defaultBase
  if (typeof base === 'string' && base.trim() !== '') {
    const branch = base.trim().replace(/^origin\//, '')
    out.push({
      field: 'baseBranch',
      source: quoteTsLiteral(branch),
      note: `nx.json \`defaultBase\` ${JSON.stringify(base.trim())}: add \`baseBranch: ${JSON.stringify(branch)}\` to .vx/workspace.ts`,
    })
  }
  return out
}
