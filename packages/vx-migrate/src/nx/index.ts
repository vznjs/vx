// `@vzn/vx-migrate` — an Nx repo under vx with nothing written.
//
// Fills the `project` stage from the RESOLVED Nx project graph: every
// package the workspace discovers is given the tasks its Nx targets
// define, mapped by the same mapper `bunx @vzn/vx-migrate --from nx`
// renders files from — so what runs here is what a migration would have
// written, minus the file. Executor targets run through `nx-exec` (one
// executor, one process, Nx's own `runExecutor`) unless the workspace
// translates the executor (`executors`); run-commands targets
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
import { availableParallelism } from 'node:os'
import path from 'node:path'
import {
  refuseUnknownOptions,
  type PluginOptionKinds,
  type GeneratedProject,
  type ProjectMeta,
  UserError,
  type VxPlugin,
} from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import { collectGaps } from '../plugin-gaps.js'
import {
  BUILTIN_EXECUTORS,
  mapNxWorkspace,
  type NxExecutors,
  type NxGraph,
  nxSizeText,
  parseNxGraph,
  readNxJson,
} from './nx-map.js'
import { exportGraph } from './export-graph.js'
export type {
  NxExecutors,
  NxExecutorTarget,
  NxExecutorTranslation,
  NxExecutorTranslator,
} from './nx-map.js'
import { listDotenv } from './nx-dotenv.js'
import { trackedKinds } from '../tracked-outputs.js'
import { relPosix } from '../paths.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { yarnrcText } from '../script-command.js'

/** The note every persistent task carries; like every gap, reported once per run for all its tasks. */
const PERSISTENT_NOTE =
  'a continuous target (or a server executor) — vx runs it as a persistent task that is ' +
  'ready on spawn; add `exec.persistent.readyWhen` in a vx.config to gate dependents on its output'

/** The snapshot's name under vx's cache dir — local to the machine, like the cache. */
const SNAPSHOT = 'nx-project-graph.json'
/** What the snapshot was exported from (`graphInputKey`), beside it. */
const SNAPSHOT_KEY = 'nx-project-graph.key'
/** The files at the workspace root whose edit can move Nx's graph. */
const ROOT_GRAPH_FILE =
  /^(nx\.json|package\.json|\.nxignore|tsconfig[^/]*\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/

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
  /**
   * Your own executors as commands, by executor name: each function gets
   * the target (project, root, configuration, resolved options) and
   * returns `{ command, timeout?, env? }`, or undefined to run that target
   * through `nx-exec`. `nx:run-commands`, `nx:run-script` and `nx:noop`
   * are translated already and cannot be named. A function's source text
   * keys the cached mapping, so it should depend on its argument alone.
   */
  readonly executors?: NxExecutors
}

/** Each option `NxPluginOptions` names, with its kind: derived from the type, so the two cannot drift. */
const NX_PLUGIN_KEYS: PluginOptionKinds<NxPluginOptions> = {
  root: 'string',
  graph: 'string',
  executors: 'object',
}

function refuseExecutors(executors: NxExecutors | undefined): void {
  for (const [name, fn] of Object.entries(executors ?? {})) {
    if (BUILTIN_EXECUTORS.has(name))
      throw new UserError(
        `nx() option "executors": ${JSON.stringify(name)} is translated by nx() itself`,
      )
    if (typeof fn !== 'function')
      throw new UserError(`nx() option "executors": ${JSON.stringify(name)} must be a function`)
  }
}

/** The plugin: the adoption skeleton over `mapNxWorkspace`, one mapping per run. */
export function nx(options: NxPluginOptions = {}): VxPlugin {
  refuseUnknownOptions('nx()', options, NX_PLUGIN_KEYS)
  refuseExecutors(options.executors)
  // One graph load per RUN, shared by `discover` and `project`: the run
  // hands both stages the same projects array (discover's, grown by what
  // it named), so its identity is the run's, as the mapping's is.
  let graphFor: readonly ProjectMeta[] | undefined
  let graph: Promise<LoadedGraph> | undefined
  const graphOf = (
    root: string,
    cacheDir: string,
    projects: readonly ProjectMeta[],
    changes?: WorktreeChanges,
  ) => {
    if (graphFor !== projects) {
      graphFor = projects
      graph = loadGraph(root, cacheDir, projects, options.graph, changes)
    }
    return graph!
  }
  return adoptionPlugin(
    import.meta,
    async (ctx) => {
      const root = options.root ?? ctx.workspaceRoot
      return mapAll(
        root,
        ctx.projects,
        await graphOf(root, ctx.cacheDir, ctx.projects),
        options.executors,
      )
    },
    // At the workspace root only, as `turbo()` claims its file.
    options.root === undefined ? ['nx.json'] : [],
    {
      async config(workspace, ctx) {
        const root = options.root ?? ctx.workspaceRoot
        if (workspace.affectedBase === undefined) {
          const base = await nxBase(root)
          if (base !== undefined) workspace.affectedBase = base
        }
        if (workspace.concurrency === undefined) {
          const parallel = await nxParallel(root)
          if (parallel !== undefined) workspace.concurrency = parallel
        }
        if (workspace.cacheRetention === undefined) {
          const maxSize = await nxMaxCacheSize(root)
          if (maxSize !== undefined) workspace.cacheRetention = { maxSize }
        }
      },
      // An integrated Nx repo keeps projects out of the package manager's
      // list (analogjs: `project.json` libraries no glob names), and their
      // targets had nowhere to attach: 1 of 21 `build` tasks ran. Each
      // graph node with targets at a directory core did not find is named
      // a project, by its package.json name or else its Nx name; a name a
      // project already holds stays unattached, and the mapping says so.
      async discover(ctx) {
        const root = options.root ?? ctx.workspaceRoot
        // Core's status is the workspace's: a root elsewhere asks git itself.
        const changes = options.root === undefined ? () => ctx.worktreeChanges() : undefined
        const { graph } = await graphOf(root, ctx.cacheDir, ctx.projects, changes)
        const dirs = new Set(ctx.projects.map((m) => path.resolve(m.dir)))
        const names = new Set(ctx.projects.map((m) => m.name))
        const named: Array<{ dir: string; name: string }> = []
        for (const [nodeName, node] of Object.entries(graph.nodes)) {
          if (node?.data?.targets === undefined) continue
          const dir = path.resolve(root, node.data.root ?? '')
          if (dirs.has(dir) || !isWithin(ctx.workspaceRoot, dir)) continue
          // A graph older than the tree can name a directory since removed.
          if (
            !(await stat(dir).then(
              (s) => s.isDirectory(),
              () => false,
            ))
          )
            continue
          const pkg = (await Bun.file(path.join(dir, 'package.json'))
            .json()
            .catch(() => null)) as { name?: unknown } | null
          const name = typeof pkg?.name === 'string' && pkg.name !== '' ? pkg.name : nodeName
          if (names.has(name)) continue
          names.add(name)
          dirs.add(dir)
          named.push({ dir, name })
        }
        return named
      },
    },
  )
}

function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * nx.json's `parallel` (or the legacy runner's option): how many tasks Nx
 * runs at once. Read by nothing, a repo that set 1 for a shared database
 * ran on every core under vx (TanStack/router sets 5, nx-examples 1).
 */
async function nxParallel(root: string): Promise<number | undefined> {
  // `NX_PARALLEL` (a count, or `50%` of the cores) wins over nx.json, as
  // Nx 23's `readParallelFromArgsAndEnv` reads it; a CI that set 2 for a
  // small runner got nx.json's number under vx.
  const env = process.env['NX_PARALLEL']?.trim()
  if (env) {
    const n = Number.parseInt(env, 10)
    const p = env.endsWith('%') ? Math.floor((availableParallelism() * n) / 100) : n
    if (Number.isInteger(p)) return Math.max(1, p)
  }
  const json = (await readNxJson(root).catch(() => null))?.json as
    | {
        parallel?: unknown
        tasksRunnerOptions?: { default?: { options?: { parallel?: unknown } } }
      }
    | undefined
  const p = json?.parallel ?? json?.tasksRunnerOptions?.default?.options?.parallel
  return typeof p === 'number' && Number.isInteger(p) && p > 0 ? p : undefined
}

/**
 * What `nx affected` compares with when no `--base` is given: `NX_BASE`,
 * then nx.json's `defaultBase` (Nx 19's `affected.defaultBase` before it).
 * Read by nothing, a git-flow repo's `develop` was lost and a bare
 * `vx run … --affected` diffed against origin/HEAD.
 */
async function nxBase(root: string): Promise<string | undefined> {
  const env = Bun.env['NX_BASE']?.trim()
  if (env) return env
  const json = (await readNxJson(root).catch(() => null))?.json as
    | { defaultBase?: unknown; affected?: { defaultBase?: unknown } }
    | undefined
  const b = json?.defaultBase ?? json?.affected?.defaultBase
  return typeof b === 'string' && b.trim() !== '' ? b.trim() : undefined
}

/**
 * nx.json's `maxCacheSize`, or `NX_MAX_CACHE_SIZE` above it, as core's
 * size: Nx caps its local cache there (`resolveMaxCacheSize`), and read by
 * nothing a capped cache grew without bound under vx, as turbo.json's
 * `cacheMaxSize` once did (G-49). 1024-based, a fraction truncated to
 * bytes; `0` is no cap. A value Nx would refuse is left to core's
 * refusal, which names the field.
 */
async function nxMaxCacheSize(root: string): Promise<string | undefined> {
  const env = process.env['NX_MAX_CACHE_SIZE']
  const raw =
    env !== undefined
      ? env
      : ((await readNxJson(root).catch(() => null))?.json as { maxCacheSize?: unknown } | undefined)
          ?.maxCacheSize
  return nxSizeText(raw)
}

interface LoadedGraph {
  readonly text: string
  readonly graph: NxGraph
  readonly notes: readonly string[]
}

async function mapAll(
  root: string,
  metas: readonly ProjectMeta[],
  loaded: LoadedGraph,
  executors: NxExecutors | undefined,
): Promise<AdoptionRun> {
  const { text, graph, notes } = loaded
  const reads = await nxReads(root, metas, text, graph, notes)
  // The mapping is cached on what it read; a translator is code it ran.
  if (executors !== undefined)
    reads.push(JSON.stringify(Object.entries(executors).map(([k, fn]) => [k, String(fn)])))
  return {
    name: 'nx',
    spareTracked: true,
    reads,
    map: (tracked) => index(root, metas, graph, notes, tracked, executors),
  }
}

function relRoot(p: string): string {
  const s = p.replace(/\/+$/, '')
  return s === '' ? '.' : s
}

const textOf = (file: string): Promise<string> =>
  Bun.file(file)
    .text()
    .catch(() => '\0absent')

/**
 * Everything the mapping reads: the graph, nx.json and its `extends` chain, every package manifest
 * and the package.json of each graph node no package matches (its
 * synthetic project's name), the `.env` names in every project dir,
 * NX_LOAD_DOT_ENV_FILES, whether the bins the tasks run are installed,
 * and the graph load's own notes.
 */
async function nxReads(
  root: string,
  metas: readonly ProjectMeta[],
  graphText: string,
  graph: NxGraph,
  notes: readonly string[],
): Promise<string[]> {
  const known = new Set(metas.map((m) => relRoot(path.relative(root, m.dir))))
  const unmatched = Object.values(graph.nodes)
    .map((n) => relRoot(n?.data?.root ?? ''))
    .filter((r) => !known.has(r))
    .sort()
  const dotenv = await listDotenv(root, [...known, ...unmatched])
  const installed = await Promise.all(
    [
      ['.bin', 'nx-exec'],
      ['.bin', 'nx-env'],
      ['nx', 'package.json'],
    ].map((p) => Bun.file(path.join(root, 'node_modules', ...p)).exists()),
  )
  // nx.json's whole `extends` chain: the mapper reads named inputs from it.
  const chain = (await readNxJson(root).catch(() => null))?.files ?? [path.join(root, 'nx.json')]
  return [
    graphText,
    ...(await Promise.all(chain.map(textOf))),
    // A config file added beside mapped tasks changes what an output may cover.
    JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson, m.configPath])),
    ...(await Promise.all(unmatched.map((r) => textOf(path.join(root, r, 'package.json'))))),
    JSON.stringify(
      [...dotenv]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([d, names]) => [d, [...names].sort()]),
    ),
    String(process.env['NX_LOAD_DOT_ENV_FILES']),
    JSON.stringify(installed),
    await yarnrcText(root),
    ...notes,
  ]
}

async function index(
  root: string,
  metas: readonly ProjectMeta[],
  graph: NxGraph,
  loadNotes: readonly string[],
  trackedFiles: () => Promise<readonly string[] | null>,
  executors: NxExecutors | undefined,
): Promise<AdoptionMapping> {
  const notes = [...loadNotes]
  const tracked = await trackedFiles()
  const configs = new Map(
    metas.flatMap((m) =>
      m.configPath === null
        ? []
        : [[relRoot(relPosix(root, m.dir)), path.basename(m.configPath)] as const],
    ),
  )
  const mapped = await mapNxWorkspace(root, metas, graph, {
    persistentTodo: PERSISTENT_NOTE,
    cacheable: new Set(),
    attached: new Set(metas.map((m) => m.name)),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    ownConfig: (rel) => configs.get(relRoot(rel)) ?? null,
    ...(executors === undefined ? {} : { executors }),
  })
  notes.push(...mapped.notes)
  const byName = new Map<string, GeneratedProject>()
  const visited = new Set(metas.map((m) => m.name))
  const unattached: string[] = []
  for (const project of mapped.projects) {
    // The mapper synthesizes a project for a graph node no package
    // matches; `discover` made each one a project, but for a name a
    // package holds or a directory gone. Those have nowhere to go.
    if (!visited.has(project.name)) {
      unattached.push(project.name)
      continue
    }
    byName.set(project.name, project)
  }
  if (unattached.length > 0) {
    notes.push(
      `Nx project(s) ${unattached.join(', ')} have no workspace package to attach targets to ` +
        '(a package holds the name, or the directory is gone) — run those targets with nx',
    )
  }
  // The bins executor lines and `.env`-loading lines start with: installed
  // by this package, so absent only when the plugin is loaded by path (a
  // checkout, a link) — then every such task would fail with `not found`.
  const uses = (bin: string) =>
    [...byName.values()].some((p) =>
      p.tasks.some((t) => {
        const cmd = (t.task?.['exec'] as { command?: unknown } | undefined)?.command
        return typeof cmd === 'string' && cmd.startsWith(`${bin} `)
      }),
    )
  let loadsNx = false
  for (const [bin, what] of [
    ['nx-exec', 'executor targets run'],
    ['nx-env', 'targets with `.env` files run'],
  ] as const) {
    if (!uses(bin)) continue
    loadsNx = true
    if (!(await Bun.file(path.join(root, 'node_modules', '.bin', bin)).exists())) {
      notes.push(
        `${what} through \`${bin}\`, which is not in node_modules/.bin — add ` +
          "@vzn/vx-migrate to the workspace's devDependencies so its bin is on every task's PATH",
      )
    }
  }
  // Both bins run Nx's own code from the workspace; a repo run from an
  // exported `graph` may have none installed.
  if (
    loadsNx &&
    !(await Bun.file(path.join(root, 'node_modules', 'nx', 'package.json')).exists())
  ) {
    notes.push(
      'nx-exec and nx-env load Nx from the workspace, and node_modules/nx is not there — ' +
        'install nx, or those tasks fail',
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

/**
 * The project roots of the graph last exported, absolute; none without
 * one. Not the workspace root: its own files count as the root's do
 * (`ROOT_GRAPH_FILE`), and a stray write there re-exported every run.
 */
async function snapshotRoots(root: string, snapshot: string): Promise<string[]> {
  try {
    const nodes = parseNxGraph(await Bun.file(snapshot).text(), snapshot).nodes
    return Object.values(nodes)
      .map((n) => path.resolve(root, n?.data?.root ?? ''))
      .filter((d) => d !== path.resolve(root))
  } catch {
    return []
  }
}

/** The newest mtime among the files whose edit changes the graph, or 0 when none is readable. */
async function newestInput(root: string, dirs: readonly string[]): Promise<number> {
  // nx.json's `extends` chain too: a base's edit changes the graph as much.
  const nxJson = await readNxJson(root).catch(() => null)
  const files = [
    ...(nxJson?.files ?? [path.join(root, 'nx.json')]),
    path.join(root, 'package.json'),
  ]
  for (const d of dirs) files.push(path.join(d, 'project.json'), path.join(d, 'package.json'))
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

/** `DiscoverContext.worktreeChanges`: git's changed paths, root-relative, or null outside a worktree. */
type WorktreeChanges = () => Promise<readonly string[] | null>

/** `git status` at `root` itself, for a graph loaded without the run's (another root, a skipped discover). */
async function ownChanges(root: string): Promise<string[] | null> {
  const status = Bun.spawn(['git', '--no-optional-locks', 'status', '--porcelain', '-z', '-uall'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [out, code] = await Promise.all([new Response(status.stdout).text(), status.exited])
  if (code !== 0) return null
  const paths: string[] = []
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    if (r.length < 4) continue
    paths.push(r.slice(3))
    // A rename or copy carries its source as the next record.
    if (r[0] === 'R' || r[0] === 'C') i++
  }
  return paths
}

/**
 * What the graph is computed from, as one digest: nx.json's chain by content,
 * and — since Nx derives edges from SOURCE imports
 * (`@nx/js`) — the worktree as git sees it: HEAD, `git status -z -uall`, and
 * the content of every path that lists. Freshness by manifest mtimes kept a
 * snapshot without the edge an added `import` makes, and a later edit to the
 * imported project replayed its dependant from cache (Next 26). The status
 * text alone is not enough: it names a modified file by path, not by what it
 * holds, so a second edit to a dirty file kept the key (measured, item 1075).
 * The status is the run's own when core hands it over (`changes`): a second
 * whole-tree walk cost refine ~96 ms of a 417 ms warm run (I-6).
 * Null outside a git worktree: the caller falls back to the mtimes.
 */
async function graphInputKey(
  root: string,
  cacheDir: string,
  dirs: readonly string[],
  changes: WorktreeChanges | undefined,
): Promise<string | null> {
  const head = Bun.spawn(['git', 'rev-parse', '--verify', '-q', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [headOut, changed] = await Promise.all([
    new Response(head.stdout).text(),
    changes === undefined ? ownChanges(root) : changes(),
  ])
  await head.exited
  if (changed === null) return null
  // The cache dir holds the snapshot itself: a workspace that does not
  // ignore it would see the export move the key it was keyed on.
  const cacheRel = path.relative(root, cacheDir).split(path.sep).join('/')
  const inCache = (p: string): boolean =>
    cacheRel !== '' &&
    !cacheRel.startsWith('..') &&
    (p === cacheRel || p.startsWith(`${cacheRel}/`))
  // Nx's own caches, written by the export itself: under a root project
  // (a standalone repo) that does not ignore them, each export moved the key
  // and the next run exported again. `.nx/installation` pins Nx's version
  // and stays in.
  const nxCache = (p: string): boolean =>
    p.startsWith('.nx/cache/') || p.startsWith('.nx/workspace-data/')
  // What can move the graph: a file under a project root (its sources, the
  // configs a plugin infers targets from), or a root file Nx reads. A task's
  // stray write at the root (a report, a log) is not, and counting it
  // re-exported the graph on every run after it.
  // A `project.json` anywhere: a new one is a project no root lists yet.
  const roots = dirs.map((d) => path.relative(root, d).split(path.sep).join('/'))
  const graphFile = (p: string): boolean =>
    p === 'project.json' ||
    p.endsWith('/project.json') ||
    roots.some((r) => r === '' || p.startsWith(`${r}/`)) ||
    (!p.includes('/') && ROOT_GRAPH_FILE.test(p))
  const listed = [...new Set(changed.filter((p) => !inCache(p) && !nxCache(p) && graphFile(p)))]
  // A manifest needs no read of its own: git lists it when it is edited, and
  // HEAD moves when an edit is committed (reading all 2,000 cost 50 ms at
  // 1,000 projects). nx.json's chain does: a base may sit in node_modules,
  // where git does not look.
  const nxJson = await readNxJson(root).catch(() => null)
  const files = [
    ...(nxJson?.files ?? [path.join(root, 'nx.json')]),
    ...listed.sort().map((p) => path.join(root, p)),
  ]
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(`${headOut.trim()}\0`)
  const bodies = await Promise.all(
    files.map((f) =>
      Bun.file(f)
        .bytes()
        .catch(() => null),
    ),
  )
  files.forEach((f, i) => {
    const body = bodies[i] ?? null
    hasher.update(`${f}\0${body === null ? 'gone' : body.length}\0`)
    if (body !== null) hasher.update(body)
  })
  return hasher.digest('hex')
}

async function loadGraph(
  root: string,
  cacheDir: string,
  metas: readonly ProjectMeta[],
  exported: string | undefined,
  changes: WorktreeChanges | undefined,
): Promise<LoadedGraph> {
  const notes: string[] = []
  const { text, label } = await loadGraphText(root, cacheDir, metas, exported, notes, changes)
  return { text, graph: parseNxGraph(text, label), notes }
}

async function loadGraphText(
  root: string,
  cacheDir: string,
  metas: readonly ProjectMeta[],
  exported: string | undefined,
  notes: string[],
  changes: WorktreeChanges | undefined,
): Promise<{ text: string; label: string }> {
  if (exported !== undefined) {
    const file = path.resolve(root, exported)
    const text = await Bun.file(file)
      .text()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        throw new UserError(`[@vzn/vx-migrate] nx(): cannot read graph ${exported}: ${msg}`)
      })
    return { text, label: exported }
  }
  const snapshot = path.join(cacheDir, SNAPSHOT)
  const keyFile = path.join(cacheDir, SNAPSHOT_KEY)
  // The last graph's project roots with the discovered ones: `discover`
  // loads the graph before the projects it names are projects, and an
  // edit under one of them must still move the key.
  const dirs = [...new Set([...metas.map((m) => m.dir), ...(await snapshotRoots(root, snapshot))])]
  const [have, key, keyed] = await Promise.all([
    stat(snapshot).then(
      (s) => s.mtimeMs,
      () => -1,
    ),
    graphInputKey(root, cacheDir, dirs, changes),
    Bun.file(keyFile)
      .text()
      .catch(() => null),
  ])
  // Keyed before the export, so an edit made while Nx computes costs one
  // more export instead of hiding under the new snapshot.
  const stale = key === null ? have < (await newestInput(root, dirs)) : have < 0 || keyed !== key
  if (stale) {
    const failure = await exportGraph(root, snapshot)
    if (failure !== null) {
      if (have < 0) throw new UserError(`[@vzn/vx-migrate] nx(): ${failure}`)
      notes.push(`${failure} — running on the previous graph snapshot`)
    } else if (key !== null) {
      // Keyed as the next run will key it: over the roots this export
      // found too, or a first export (no snapshot to read roots from)
      // re-exported on the run after.
      const found = (await snapshotRoots(root, snapshot)).filter((d) => !dirs.includes(d))
      const next =
        found.length > 0 ? await graphInputKey(root, cacheDir, [...dirs, ...found], changes) : key
      if (next !== null) await Bun.write(keyFile, next)
    }
  }
  return { text: await Bun.file(snapshot).text(), label: path.relative(root, snapshot) }
}
