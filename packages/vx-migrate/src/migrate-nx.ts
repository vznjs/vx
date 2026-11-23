// `bunx @vzn/vx-migrate --from nx`: the resolved graph snapshot on disk,
// through the mapper the `nx()` plugin runs live, as a migration plan.

import path from 'node:path'
import {
  type GeneratedProject,
  type MigrationFormat,
  type MigrationPlan,
  quoteTsLiteral,
} from '@vzn/vx'
import type { PackageMeta } from './packages.js'
import { mapNxWorkspace, parseNxGraph, readNxJson } from './nx/nx-map.js'
import { nxDependencyRules } from './nx/nx-boundaries.js'
import { rulesSource } from './dependency-rules.js'
import { spareTrackedTodos, trackedFiles, trackedKinds } from './tracked-outputs.js'
import { adoptedToolNotes } from './workspace-notes.js'

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
  spareTrackedTodos(root, mapped.projects, tracked)
  const adopted = await adoptedToolNotes(root, {
    plugin: 'nx',
    config: 'nx.json',
    runner: 'nx',
    keys: (lock) => `Nx keys each project on the npm packages it depends on in ${lock}`,
  })
  if (bare) for (const p of mapped.projects) explicitOnly(p)
  else nameUnlisted(root, metas, mapped.projects)
  return {
    headerNotes: [
      // CopilotKit maps every target to a shell line: no nx-exec to keep.
      bare || binTasks(mapped.projects).length === 0
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
    extraFiles: [],
    notes: [
      ...mapped.notes,
      ...(bare ? bareNotes(mapped.projects) : []),
      ...(await nxWorkspaceFieldsOf(root))
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

/** The tasks that run `nx-exec` or `nx-env`, this package's bins. */
const binTasks = (projects: readonly GeneratedProject[]): string[] =>
  projects.flatMap((p) =>
    p.tasks.flatMap((t) => {
      const cmd = (t.task?.['exec'] as { command?: unknown } | undefined)?.command
      return typeof cmd === 'string' && /^nx-(exec|env) /.test(cmd) ? [`${p.name}#${t.name}`] : []
    }),
  )

/** `nx-exec` and `nx-env` are this package's bins, and a repo with no package.json cannot install it. */
function bareNotes(projects: readonly GeneratedProject[]): string[] {
  const ids = binTasks(projects)
  if (ids.length === 0) return []
  return [
    `${ids.join(', ')} run${ids.length === 1 ? 's' : ''} through nx-exec or nx-env, @vzn/vx-migrate's bins, which a repo with no package.json cannot install: rewrite ${ids.length === 1 ? 'it' : 'them'} as commands`,
  ]
}

/**
 * Nx projects no member of the package manager's workspace holds (an
 * integrated repo's `project.json` libraries): core finds a project by its
 * vx.config, not by a package.json, so each config names the project as
 * Nx does and its dependants spell it. A single-version repo lists no
 * members on purpose: writing package.json files and asking for globs made
 * the manager install each library's own ranges (transloco, angular-three)
 * and hoist a slashed name into a library's source (ngxtension). Its
 * dependencies resolve from the root, whose lockfile entry keys it.
 */
function nameUnlisted(
  root: string,
  metas: readonly PackageMeta[],
  projects: readonly { dir: string; writeName?: boolean }[],
): void {
  const listed = new Set(metas.map((m) => path.resolve(m.dir)))
  for (const p of projects) {
    const dir = path.resolve(p.dir)
    if (dir !== path.resolve(root) && !listed.has(dir)) p.writeName = true
  }
}

/** A `.vx/workspace.ts` field nx.json's run settings call for. */
export interface NxWorkspaceField {
  /** The setting's path: its group, then its field, or a top-level key. */
  readonly field: 'run.concurrency' | 'run.rules' | 'baseBranch'
  /** The value as TypeScript source; undefined when vx cannot read it. */
  readonly source: string | undefined
  /** What to tell a user whose workspace file this run does not write. */
  readonly note: string
}

/**
 * `nxWorkspaceFields` and the root ESLint config's module boundaries, which
 * `nx()` applies live as `run.rules.dependencies`: a migration that wrote
 * neither checked no boundary once `nx()` was gone.
 */
export async function nxWorkspaceFieldsOf(root: string): Promise<NxWorkspaceField[]> {
  const fields = nxWorkspaceFields((await readNxJson(root).catch(() => null))?.json)
  const rules = await nxDependencyRules(root)
  if (rules !== undefined && rules.length > 0) {
    const source = rulesSource(rules)
    fields.push({
      field: 'run.rules',
      source,
      note: `@nx/enforce-module-boundaries' depConstraints: add \`run: { rules: ${source} }\` to .vx/workspace.ts`,
    })
  }
  return fields
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
