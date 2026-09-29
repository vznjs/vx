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
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import { collectGaps } from '../plugin-gaps.js'
import { mapNxWorkspace, type NxGraph, parseNxGraph, readNxJson } from './nx-map.js'
import { listDotenv } from './nx-dotenv.js'
import type { AdoptionMapping } from '../mapping-cache.js'

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
}

/** The plugin: the adoption skeleton over `mapNxWorkspace`, one mapping per run. */
export function nx(options: NxPluginOptions = {}): VxPlugin {
  return adoptionPlugin(
    import.meta,
    (ctx) => mapAll(options.root ?? ctx.workspaceRoot, ctx.cacheDir, ctx.projects, options),
    // At the workspace root only, as `turbo()` claims its file.
    options.root === undefined ? ['nx.json'] : [],
    {
      async config(workspace, ctx) {
        if (workspace.concurrency !== undefined) return
        const parallel = await nxParallel(options.root ?? ctx.workspaceRoot)
        if (parallel !== undefined) workspace.concurrency = parallel
      },
    },
  )
}

/**
 * nx.json's `parallel` (or the legacy runner's option): how many tasks Nx
 * runs at once. Read by nothing, a repo that set 1 for a shared database
 * ran on every core under vx (TanStack/router sets 5, nx-examples 1).
 */
async function nxParallel(root: string): Promise<number | undefined> {
  const json = (await readNxJson(root).catch(() => null))?.json as
    | {
        parallel?: unknown
        tasksRunnerOptions?: { default?: { options?: { parallel?: unknown } } }
      }
    | undefined
  const p = json?.parallel ?? json?.tasksRunnerOptions?.default?.options?.parallel
  return typeof p === 'number' && Number.isInteger(p) && p > 0 ? p : undefined
}

async function mapAll(
  root: string,
  cacheDir: string,
  metas: readonly ProjectMeta[],
  options: NxPluginOptions,
): Promise<AdoptionRun> {
  const notes: string[] = []
  const loaded = await loadGraph(root, cacheDir, metas, options.graph, notes)
  const graph = parseNxGraph(loaded.text, loaded.label)
  return {
    name: 'nx',
    reads: await nxReads(root, metas, loaded.text, graph, notes),
    map: () => index(root, metas, graph, notes),
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
    JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson])),
    ...(await Promise.all(unmatched.map((r) => textOf(path.join(root, r, 'package.json'))))),
    JSON.stringify(
      [...dotenv]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([d, names]) => [d, [...names].sort()]),
    ),
    String(process.env['NX_LOAD_DOT_ENV_FILES']),
    JSON.stringify(installed),
    ...notes,
  ]
}

async function index(
  root: string,
  metas: readonly ProjectMeta[],
  graph: NxGraph,
  loadNotes: readonly string[],
): Promise<AdoptionMapping> {
  const notes = [...loadNotes]
  const mapped = await mapNxWorkspace(root, metas, graph, {
    persistentTodo: PERSISTENT_NOTE,
    cacheable: new Set(),
    attached: new Set(metas.map((m) => m.name)),
  })
  notes.push(...mapped.notes)
  const byName = new Map<string, GeneratedProject>()
  const visited = new Set(metas.map((m) => m.name))
  const unattached: string[] = []
  let rootUnattached = false
  for (const project of mapped.projects) {
    // The mapper synthesizes a project for a graph node no package
    // matches — the root project, usually. The stage visits packages,
    // so those targets have nowhere to go; say so once. A root with a
    // vx.config is a project (core's D-39), and its targets attach.
    if (!visited.has(project.name)) {
      unattached.push(project.name)
      if (path.resolve(project.dir) === path.resolve(root)) rootUnattached = true
      continue
    }
    byName.set(project.name, project)
  }
  if (unattached.length > 0) {
    notes.push(
      `Nx project(s) ${unattached.join(', ')} have no workspace package to attach targets to ` +
        (rootUnattached
          ? '(the workspace root: a vx.config there makes it a project) — run those targets with nx, or add one'
          : '— run those targets with nx, or declare them in a vx.config'),
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

/** The newest mtime among the files whose edit changes the graph, or 0 when none is readable. */
async function newestInput(root: string, metas: readonly ProjectMeta[]): Promise<number> {
  // nx.json's `extends` chain too: a base's edit changes the graph as much.
  const nxJson = await readNxJson(root).catch(() => null)
  const files = [
    ...(nxJson?.files ?? [path.join(root, 'nx.json')]),
    path.join(root, 'package.json'),
  ]
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

/**
 * What the graph is computed from, as one digest: nx.json's chain by content,
 * and — since Nx derives edges from SOURCE imports
 * (`@nx/js`) — the worktree as git sees it: HEAD, `git status -z -uall`, and
 * the content of every path that lists. Freshness by manifest mtimes kept a
 * snapshot without the edge an added `import` makes, and a later edit to the
 * imported project replayed its dependant from cache (Next 26). The status
 * text alone is not enough: it names a modified file by path, not by what it
 * holds, so a second edit to a dirty file kept the key (measured, item 1075).
 * Null outside a git worktree: the caller falls back to the mtimes.
 */
async function graphInputKey(
  root: string,
  cacheDir: string,
  metas: readonly ProjectMeta[],
): Promise<string | null> {
  const git = (args: string[]) =>
    Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const head = git(['rev-parse', '--verify', '-q', 'HEAD'])
  const status = git(['status', '--porcelain', '-z', '-uall'])
  const [headOut, statusOut, statusCode] = await Promise.all([
    new Response(head.stdout).text(),
    new Response(status.stdout).text(),
    status.exited,
  ])
  await head.exited
  if (statusCode !== 0) return null
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
  const roots = metas.map((m) => path.relative(root, m.dir).split(path.sep).join('/'))
  const graphFile = (p: string): boolean =>
    roots.some((r) => r === '' || p.startsWith(`${r}/`)) ||
    (!p.includes('/') && ROOT_GRAPH_FILE.test(p))
  const listed: string[] = []
  const records = statusOut.split('\0')
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    if (r.length < 4) continue
    const p = r.slice(3)
    // A rename or copy carries its source as the next record.
    if (r[0] === 'R' || r[0] === 'C') i++
    if (!inCache(p) && !nxCache(p) && graphFile(p)) listed.push(p)
  }
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
  notes: string[],
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
  const [have, key, keyed] = await Promise.all([
    stat(snapshot).then(
      (s) => s.mtimeMs,
      () => -1,
    ),
    graphInputKey(root, cacheDir, metas),
    Bun.file(keyFile)
      .text()
      .catch(() => null),
  ])
  // Keyed before the export, so an edit made while Nx computes costs one
  // more export instead of hiding under the new snapshot.
  const stale = key === null ? have < (await newestInput(root, metas)) : have < 0 || keyed !== key
  if (stale) {
    const failure = await exportGraph(root, snapshot)
    if (failure !== null) {
      if (have < 0) throw new UserError(`[@vzn/vx-migrate] nx(): ${failure}`)
      notes.push(`${failure} — running on the previous graph snapshot`)
    } else if (key !== null) {
      await Bun.write(keyFile, key)
    }
  }
  return { text: await Bun.file(snapshot).text(), label: path.relative(root, snapshot) }
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
