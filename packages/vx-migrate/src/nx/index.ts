// `@vzn/vx-migrate` — an Nx repo under vx with nothing written.
//
// Fills the `project` stage from the RESOLVED Nx project graph: every
// package the workspace discovers is given the tasks its Nx targets
// define, mapped by the same mapper `bunx @vzn/vx-migrate --from nx`
// renders files from — so what runs here is what a migration would have
// written, minus the file. Executor targets run through `nx-exec` (one
// executor, one process, Nx's own `runExecutor`); run-commands targets
// run as the shell they are. A task the package's own vx.config already
// declares wins; the plugin never overwrites a user's hand.
//
// The graph: Nx resolves plugin-inferred targets, `targetDefaults`,
// named inputs and `{projectRoot}` tokens when it BUILDS the graph, so
// the plugin reads a built one and never re-derives any of it. Once per
// run it stats `nx.json` and every discovered package's `project.json`
// and `package.json` against its snapshot under vx's cache dir; a newer
// one (or no snapshot) runs `nx graph --file=<snapshot>` — the only time
// Nx itself runs — and a fresh snapshot costs the stats alone. Design:
// docs/design/nx-unchanged-2026-09.md.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import { type GeneratedProject, type ProjectMeta, UserError, type VxPlugin } from '@vzn/vx'
import { adoptionPlugin } from '../adoption-plugin.js'
import { collectGaps, type Gaps } from '../plugin-gaps.js'
import { mapNxWorkspace, type NxGraph, parseNxGraph } from './nx-map.js'

/** The note every persistent task carries; like every gap, reported once per run for all its tasks. */
const PERSISTENT_NOTE =
  'a server executor (or a serve-like target name) — vx runs it as a persistent task that is ' +
  'ready on spawn; add `exec.persistent.readyWhen` in a vx.config to gate dependents on its output'

/** The snapshot's name under vx's cache dir — local to the machine, like the cache. */
const SNAPSHOT = 'nx-project-graph.json'

export interface NxPluginOptions {
  /**
   * Where `nx.json` lives. Defaults to the workspace root; a repo whose Nx
   * workspace sits elsewhere names the directory here.
   */
  readonly root?: string
  /**
   * An exported graph to read instead of keeping a snapshot — a path
   * relative to `root` (or absolute) written by `nx graph --file=<path>`.
   * With it set the plugin never runs `nx`; the file is the truth until
   * it is exported again.
   */
  readonly graph?: string
}

/** The plugin: the adoption skeleton over `mapNxWorkspace`, one mapping per run. */
export function nx(options: NxPluginOptions = {}): VxPlugin {
  return adoptionPlugin(import.meta, (ctx) =>
    mapAll(options.root ?? ctx.workspaceRoot, ctx.cacheDir, ctx.projects, options),
  )
}

interface Indexed {
  readonly byName: ReadonlyMap<string, GeneratedProject>
  readonly gaps: Gaps
}

async function mapAll(
  root: string,
  cacheDir: string,
  metas: readonly ProjectMeta[],
  options: NxPluginOptions,
): Promise<Indexed> {
  const notes: string[] = []
  const graph = await loadGraph(root, cacheDir, metas, options.graph, notes)
  const mapped = await mapNxWorkspace(root, metas, graph, {
    persistentTodo: PERSISTENT_NOTE,
    cacheable: new Set(),
  })
  const byName = new Map<string, GeneratedProject>()
  const visited = new Set(metas.map((m) => m.name))
  const unattached: string[] = []
  for (const project of mapped.projects) {
    // The mapper synthesizes a project for a graph node no package
    // matches — the root project, usually. The stage visits packages,
    // so those targets have nowhere to go; say so once.
    if (!visited.has(project.name)) {
      unattached.push(project.name)
      continue
    }
    byName.set(project.name, project)
  }
  if (unattached.length > 0) {
    notes.push(
      `Nx project(s) ${unattached.join(', ')} have no workspace package to attach targets to ` +
        '(the root project, usually) — run those targets with nx, or declare them in a vx.config',
    )
  }
  notes.push(...mapped.notes)
  // The bin every executor line starts with: installed by this package,
  // so it is absent only when the plugin is loaded by path (a checkout, a
  // link) — then every such task would fail with `nx-exec: not found`.
  const usesBin = [...byName.values()].some((p) =>
    p.tasks.some((t) => {
      const cmd = (t.task?.['exec'] as { command?: unknown } | undefined)?.command
      return typeof cmd === 'string' && cmd.startsWith('nx-exec ')
    }),
  )
  if (usesBin && !(await Bun.file(path.join(root, 'node_modules', '.bin', 'nx-exec')).exists())) {
    notes.push(
      'executor targets run through `nx-exec`, which is not in node_modules/.bin — add ' +
        "@vzn/vx-migrate to the workspace's devDependencies so its bin is on every task's PATH",
    )
  }
  return {
    byName,
    gaps: collectGaps(
      mapped.projects.filter((p) => byName.has(p.name)),
      notes,
    ),
  }
}

/** The newest mtime among the files whose edit changes the graph, or 0 when none is readable. */
async function newestInput(root: string, metas: readonly ProjectMeta[]): Promise<number> {
  const files = [path.join(root, 'nx.json'), path.join(root, 'package.json')]
  for (const m of metas)
    files.push(path.join(m.dir, 'project.json'), path.join(m.dir, 'package.json'))
  const mtimes = await Promise.all(
    files.map((f) =>
      stat(f).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  )
  return Math.max(...mtimes)
}

async function loadGraph(
  root: string,
  cacheDir: string,
  metas: readonly ProjectMeta[],
  exported: string | undefined,
  notes: string[],
): Promise<NxGraph> {
  if (exported !== undefined) {
    const file = path.resolve(root, exported)
    const text = await Bun.file(file)
      .text()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        throw new UserError(`[@vzn/vx-migrate] nx(): cannot read graph ${exported}: ${msg}`)
      })
    return parseNxGraph(text, exported)
  }
  const snapshot = path.join(cacheDir, SNAPSHOT)
  const [have, newest] = await Promise.all([
    stat(snapshot).then(
      (s) => s.mtimeMs,
      () => -1,
    ),
    newestInput(root, metas),
  ])
  if (have < newest) {
    const failure = await exportGraph(root, snapshot)
    if (failure !== null) {
      if (have < 0) throw new UserError(`[@vzn/vx-migrate] nx(): ${failure}`)
      notes.push(`${failure} — running on the previous graph snapshot`)
    }
  }
  return parseNxGraph(await Bun.file(snapshot).text(), path.relative(root, snapshot))
}

/**
 * `nx graph --file=<snapshot>` from the workspace's own `nx`. Returns the
 * reason it could not, or null. Nx's daemon setting is the user's: with the
 * daemon up the export is served from memory, without it Nx computes.
 */
async function exportGraph(root: string, snapshot: string): Promise<string | null> {
  const bin = path.join(root, 'node_modules', '.bin', 'nx')
  if (!(await Bun.file(bin).exists())) {
    return `no ${path.relative(root, bin)} — install nx, or export a graph with \`nx graph --file=<path>\` and pass it as graph: '<path>'`
  }
  const proc = Bun.spawn([bin, 'graph', `--file=${snapshot}`], {
    cwd: root,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code === 0 && (await Bun.file(snapshot).exists())) return null
  const tail = err.trim().split('\n').slice(-3).join(' ')
  return `nx graph --file exited ${code}${tail ? `: ${tail}` : ''}`
}

export {
  mapNxWorkspace,
  nxExecCommand,
  parseNxGraph,
  readNxJsonFacts,
  type MapNxOptions,
  type NxGraph,
  type NxMapping,
} from './nx-map.js'
