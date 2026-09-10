// `vx watch <task>` — re-run on file changes.
//
// Initial run uses the same orchestrator path as `vx run`. After it
// finishes, set up recursive filesystem watchers on every project's
// directory in the resolved scope. Filesystem changes trigger a
// debounced re-invocation of the orchestrator with the same options.
//
// The cache does the heavy lifting: re-runs are typically cache hits
// (input hash matches), so spurious events from edits outside any
// task's `cache.inputs.files` cost ~tens of ms of orchestrator
// overhead. We deliberately don't try to filter events through the
// per-task input globs — the cache key is the source of truth, and
// filtering would mean re-doing the glob/boundary work on every event.

import fs from 'node:fs'
import path from 'node:path'
import { normalizeGlob, staticPrefix, xxh3 } from '../util/index.js'
import { asTrees } from '../cache/index.js'
import { parseRunArgs, resolveRunOptions } from './run.js'
import { run as runOrchestrator, type RunOptions } from '../orchestrator/index.js'
import {
  buildPackageGraph,
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  memberBaseDirs,
  WORKSPACE_CONFIG_FILENAMES,
  WORKSPACE_FINGERPRINT_FILES,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import type { ProjectConfig } from '../config.js'
import { type CliLoadOptions, loadCliProjects, loadCliWorkspace } from './workspace-config.js'
import { taskEdges, taskEdgesFrom } from './select.js'

/** Wait this long after the last filesystem event before re-running. */
const DEBOUNCE_MS = 150

/** Paths whose changes never trigger a re-run. */
const IGNORED_SEGMENTS = ['node_modules', '.git', '.vx']
const IGNORED_SUFFIXES = ['.tsbuildinfo', '~']

/**
 * True for a path the ignore filter drops. Every project dir is watched
 * RECURSIVELY, so without this a `bun install` would re-run the graph on every
 * file it writes, and vx's own `.vx/cache` writes would trigger a cycle that
 * writes to `.vx/cache` again.
 *
 * Segment-wise, not prefix-wise: `node_modules` is ignored wherever it appears
 * in the path, not only at the root.
 */
export function isIgnoredWatchPath(rel: string): boolean {
  const segments = rel.split(path.sep)
  if (segments.some((s) => IGNORED_SEGMENTS.includes(s))) return true
  if (IGNORED_SUFFIXES.some((suf) => rel.endsWith(suf))) return true
  return false
}

/**
 * The ignore predicate a watcher applies, closed over the run's ACTUAL cache
 * directory.
 *
 * `IGNORED_SEGMENTS` covers the `.vx/cache` default, but `cacheDir` is a
 * shipped `defineWorkspace` field: point it anywhere else and vx's own cache
 * writes land in a watched subtree, so every cycle triggers the next one.
 * Measured on a relocated cache under a recursive root watcher: ONE edit kicked
 * it and the loop then ran **22 more times during 6 seconds of total silence**
 * (~3.7 re-runs/second, forever) where the default `.vx` cache settles at 0.
 * A hard-coded literal cannot see a configured path — the resolved one can.
 */
export function makeWatchIgnore(
  cacheDir: string,
  outputs: ReadonlyMap<string, readonly string[]> = new Map(),
): (base: string, filename: string) => boolean {
  const cacheAbs = path.resolve(cacheDir)
  // A task's own outputs are not edits: without this every cycle that
  // writes `dist/` (or `out.txt`) re-runs once more, reporting
  // "up-to-date" for the trouble. Matched under the directory the globs
  // are relative to, whichever watcher delivered the event.
  // The directory that HOLDS an output tree is the task's too: `dist/**`
  // does not match `dist`, and since the clean before a miss prunes an
  // emptied `dist` (2026-09-10) the task re-creates it, which the watcher
  // reports as a change to `dist` itself — a second cycle per edit,
  // reporting "up-to-date". The literal prefix of each glob (`dist` for
  // `dist/**`, `build/out` for `build/out/*.js`; nothing for `*.js`) and
  // every ancestor of it under the dir are output containers.
  // A literal entry means the file or its whole tree — the resolver's own
  // rule (`asTrees`), so the tree's files never count as edits.
  const declared = [...outputs].map(
    ([dir, globs]) =>
      [
        path.resolve(dir),
        asTrees(globs).map((g) => new Bun.Glob(g)),
        globs.map(outputContainer).filter((c) => c !== ''),
      ] as const,
  )
  return (base, filename) => {
    if (isIgnoredWatchPath(filename)) return true
    const abs = path.resolve(base, filename)
    if (abs === cacheAbs || abs.startsWith(cacheAbs + path.sep)) return true
    for (const [dir, globs, containers] of declared) {
      if (!abs.startsWith(dir + path.sep)) continue
      const rel = abs
        .slice(dir.length + 1)
        .split(path.sep)
        .join('/')
      if (globs.some((g) => g.match(rel))) return true
      if (containers.some((c) => c === rel || c.startsWith(`${rel}/`))) return true
    }
    return false
  }
}

/**
 * The literal directory a glob's matches live under (`''` when the glob
 * starts with a pattern, or negates). A literal entry is a file or its
 * whole tree (schema: literal → tree), so the entry itself is the
 * container; a pattern's is `staticPrefix` — the same rule the sandbox
 * baseline and the deferral gate read.
 */
export function outputContainer(raw: string): string {
  const glob = normalizeGlob(raw)
  if (glob.startsWith('!')) return ''
  if (!/[*?[\]{}]/.test(glob)) return glob.replace(/\/+$/, '')
  const prefix = staticPrefix(glob)
  return prefix === '.' || prefix === '/' ? '' : prefix
}

/**
 * The file `armWatcher` writes under a watched directory to prove the
 * watcher delivers. Intercepted by name before any other handling, so it
 * can never trigger a cycle, and removed before "watching" is printed.
 */
export const WATCH_PROBE = '.vx-watch-probe'

/** How long a watcher gets to report its own probe before the loop goes on without proof. */
const WATCH_PROBE_TIMEOUT_MS = 2_000

/** Anything the loop needs to shut down at exit. */
export interface WatchHandle {
  close(): void
}

export interface ArmedWatcher {
  watcher: fs.FSWatcher
  /** Resolves `true` once the watcher reported the probe, `false` on timeout. */
  ready: Promise<boolean>
}

/** How often the fallback re-walks a watched tree. */
const POLL_INTERVAL_MS = 250

/**
 * Directory names the fallback never descends into. `makeWatchIgnore`
 * already drops their EVENTS, but a poller pays for the walk itself, and
 * `node_modules` is the difference between a cheap fallback and one that
 * re-stats 40 000 files four times a second.
 */
const POLL_SKIP = new Set(['node_modules', '.git', '.vx', 'dist'])

/**
 * A watcher built from `stat`, for when the OS one cannot deliver.
 *
 * `fs.watch` on macOS is FSEvents, which needs `mach-lookup` on
 * `com.apple.FSEvents`; inside a sandbox that does not grant it the call
 * SUCCEEDS and then never fires (measured 2026-09-05: 0 events recursive,
 * 0 non-recursive, against 3 and 2 for the same writes outside — while
 * `fs.watchFile` polling delivered in both). A network filesystem or a
 * container bind mount fails the same way. Polling is slower and coarser,
 * and it is the difference between `vx watch` working there and silently
 * doing nothing.
 */
export function pollWatcher(
  dir: string,
  recursive: boolean,
  onEvent: (filename: string) => void,
  intervalMs = POLL_INTERVAL_MS,
): WatchHandle {
  let previous = new Map<string, number>()
  let first = true
  const scan = (): void => {
    const current = new Map<string, number>()
    const walk = (abs: string, rel: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return // vanished or unreadable: its files simply stop appearing
      }
      for (const e of entries) {
        if (e.name === WATCH_PROBE) continue
        const childRel = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) {
          if (recursive && !POLL_SKIP.has(e.name)) walk(path.join(abs, e.name), childRel)
          continue
        }
        if (!e.isFile()) continue
        try {
          current.set(childRel, fs.statSync(path.join(abs, e.name)).mtimeMs)
        } catch {
          // raced with a delete; the next scan settles it
        }
      }
    }
    walk(dir, '')
    if (!first) {
      for (const [rel, mtime] of current) {
        if (previous.get(rel) !== mtime) onEvent(rel)
      }
      for (const rel of previous.keys()) {
        if (!current.has(rel)) onEvent(rel)
      }
    }
    previous = current
    first = false
  }
  scan()
  // Deliberately NOT unref'd: once the native watcher is closed this timer
  // is the only thing keeping `vx watch` alive.
  const timer = setInterval(scan, intervalMs)
  return {
    close(): void {
      clearInterval(timer)
    },
  }
}

/**
 * `fs.watch` plus proof of delivery. On macOS a recursive watcher is an
 * FSEvents stream that another thread schedules AFTER the call returns, and
 * a change landing in that gap is never delivered — MEASURED 2026-09-03: a
 * write made immediately after `fs.watch` was lost 5 times in 30 under CPU
 * load (0 in 30 idle, 0 in 30 after a 50 ms pause). The gap has no fixed
 * width, so no pause is the answer and no timeout on the waiting side ever
 * was (the e2e flake this closes had one of 45 s). A probe file written
 * under the watcher and waited for is: once ITS event arrives, the stream
 * is live for everything after it.
 *
 * `onEvent` never sees the probe (create or unlink), and the probe is
 * removed before `ready` resolves.
 */
export function armWatcher(
  dir: string,
  recursive: boolean,
  onEvent: (filename: string) => void,
  timeoutMs = WATCH_PROBE_TIMEOUT_MS,
): ArmedWatcher {
  let markReady: (ok: boolean) => void = () => {}
  const seen = new Promise<boolean>((resolve) => {
    markReady = resolve
  })
  const watcher = fs.watch(dir, { recursive, persistent: true }, (_event, filename) => {
    if (filename == null || typeof filename !== 'string') return
    if (filename === WATCH_PROBE) {
      markReady(true)
      return
    }
    onEvent(filename)
  })
  const probe = path.join(dir, WATCH_PROBE)
  const ready = (async (): Promise<boolean> => {
    // The probe is subject to the very race it detects: a write that lands
    // in the gap is lost like any other (1 in 20 under a full gate's load,
    // measured 2026-09-03, with every delivered event under 60 ms). So it is
    // re-written on a short backoff until its event arrives — the first write
    // after the stream goes live is the one that proves it.
    const deadline = Date.now() + timeoutMs
    let ok = false
    let step = 50
    while (!ok) {
      try {
        fs.writeFileSync(probe, String(Date.now()))
      } catch {
        break // an unwritable dir gets no proof; the watcher is kept
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const pause = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), Math.min(step, remaining)).unref()
      })
      ok = await Promise.race([seen, pause])
      step = Math.min(step * 2, 400)
    }
    try {
      fs.unlinkSync(probe)
    } catch {
      // already gone
    }
    return ok
  })()
  return { watcher, ready }
}

export async function watchCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx watch: ${parsed.error}\n`)
    return 1
  }

  if (parsed.dry !== undefined || parsed.graph !== undefined) {
    process.stderr.write(`vx watch: --dry / --graph are not supported in watch mode\n`)
    return 1
  }
  if (parsed.summarize !== undefined || parsed.profile !== undefined) {
    process.stderr.write(
      `vx watch: --summarize / --profile are not supported in watch mode (would overwrite per cycle)\n`,
    )
    return 1
  }
  // All three format ONE run's result and are consumed by `runCmd` alone, so
  // a watch loop silently ignored them. `--verbosity 0` is not rejected: it
  // asks for the output watch already gives.
  if (parsed.report !== undefined || parsed.reportFile !== undefined || parsed.verbosity > 0) {
    process.stderr.write(
      `vx watch: --report / --report-file / --verbosity are not supported in watch mode (they report a single run)\n`,
    )
    return 1
  }
  if (parsed.tasks.length === 0) {
    process.stderr.write(`vx watch: missing task name\n`)
    return 1
  }

  const cwd = process.cwd()
  const resolved = await resolveRunOptions(parsed, cwd, parsed.tasks)
  if ('error' in resolved) {
    process.stderr.write(`vx watch: ${resolved.error}\n`)
    return 1
  }
  if ('nothingSelected' in resolved) {
    process.stderr.write(`vx watch: ${resolved.nothingSelected}\n`)
    return 0
  }
  // The watch loop owns SIGINT/SIGTERM for its whole lifetime. A cycle's
  // run() must not install its exit-the-process handlers — Ctrl-C
  // mid-cycle would kill the loop with 130 instead of the loop's own
  // clean shutdown — so it gets `signal` instead: on SIGINT/SIGTERM the
  // controller aborts, the in-flight cycle tears its children down
  // (SIGTERM, grace, SIGKILL) and returns, and the loop resolves 0.
  // Installed BEFORE the initial run: until 2026-09-10 the handlers went
  // in with the loop, so a SIGTERM during the initial run took Bun's
  // default (exit 143) and left the cycle's children running under init.
  const stop = new AbortController()
  const opts: RunOptions = { ...resolved, handleSignals: false, signal: stop.signal }
  // A staged load from the selection pass is one run's worth of configs;
  // every cycle after an edit must evaluate live.
  delete opts.staged
  process.once('SIGINT', () => {
    process.stdout.write('\nvx watch: stopped\n')
    stop.abort()
  })
  process.once('SIGTERM', () => stop.abort())

  // Enumerate projects-in-scope so we know what dirs to watch.
  // `opts.projects` is the resolved scope; undefined means "every
  // project". The watched set is what a cycle can RUN: the scope plus
  // its transitive dependencies (a cycle runs `lib#build` for
  // `app#build`'s `^build`, so a `lib` edit is an edit) — the same
  // closure `--filter 'app...'` walks, computed below once the initial
  // run has staged the configs. Plus the workspace root, for lockfile
  // changes.
  const workspaceRoot = await findWorkspaceRoot(cwd)
  const workspace = await loadWorkspace(workspaceRoot)
  const allProjects = await listProjects(workspace)
  const inScope = (all: readonly ProjectMeta[]): ProjectMeta[] =>
    opts.projects === undefined ? [...all] : all.filter((p) => opts.projects!.includes(p.name))
  const scope = inScope(allProjects)

  if (scope.length === 0) {
    process.stderr.write(`vx watch: no projects in scope\n`)
    return 1
  }

  // Initial run — same code path as `vx run`.
  //
  // Watchers do not exist yet, so an edit made WHILE this run is executing is
  // dropped by the OS and never triggers a re-run. Known and deliberate: the
  // obvious fix (install watchers first) forces `anyTaskUsesWorkspaceFiles`
  // ahead of the run to decide which watchers to install, and that marks every
  // config loaded — so the initial run's own loads become REPEATs and pay a
  // worker round-trip each (see config-eval.ts). Trading a hot-path regression
  // on every `vx watch` for a window a user rarely edits into is a bad deal;
  // closing it properly needs the workspaceWide decision made without loading
  // configs.
  process.stdout.write('vx watch: initial run...\n\n')
  await runOrchestrator(opts)
  if (stop.signal.aborted) return 0

  const load: CliLoadOptions = {
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.frozen === true ? { frozen: true } : {}),
  }
  const swept = await sweepConfigs(allProjects, workspaceRoot, load)
  const watched = await watchedProjects(workspaceRoot, allProjects, scope, load, swept.staged)
  return await runWatchLoop({
    opts,
    stop: stop.signal,
    workspaceRoot,
    projects: watched,
    workspaceWide: swept.workspaceWide,
    projectDirs: watched.map((p) => p.dir),
    workspaceInputs: swept.workspaceInputs,
    outputs: swept.outputs,
    memberBases: memberBaseDirs(workspace),
    // The workspace as the cycle that just ran saw it: a package added or
    // removed since the loop armed joins or leaves the watched set. The
    // scope is the one resolved at start; a new package joins it only as a
    // dependency of it.
    rediscover: async () => {
      const all = await listProjects(await loadWorkspace(workspaceRoot))
      const sweep = await sweepConfigs(all, workspaceRoot, load)
      const now = await watchedProjects(workspaceRoot, all, inScope(all), load, sweep.staged)
      return { projects: now, workspaceInputs: sweep.workspaceInputs, outputs: sweep.outputs }
    },
    // The RESOLVED cache dir, not the `.vx` literal — see `makeWatchIgnore`.
    cacheDir: opts.cacheDir ?? (await loadCliWorkspace(workspaceRoot)).cacheDir,
  })
}

/**
 * The projects a cycle can run, so both watcher arms cover the same dirs:
 * the scope plus its transitive dependencies through the package graph
 * and the cross-project `dependsOn` edges the task graph adds
 * (`e2e` → `app` from `dependsOn: ['app#build']`). Before this, the
 * per-project arm watched the filter's answer only, so
 * `vx watch build --filter app` never re-ran on a `lib` edit that
 * `vx run build --filter app` would have rebuilt. A whole-workspace
 * scope is every project already and walks nothing. A config the loader
 * rejects contributes no edges here; the run that just happened said so.
 */
export async function watchedProjects(
  workspaceRoot: string,
  allProjects: readonly ProjectMeta[],
  scope: readonly ProjectMeta[],
  load: CliLoadOptions = {},
  staged: ReadonlyMap<string, ProjectEntry> | null = null,
): Promise<ProjectMeta[]> {
  if (scope.length === allProjects.length) return [...allProjects]
  let edges: Map<string, string[]> | undefined
  try {
    edges =
      staged !== null
        ? taskEdgesFrom(staged)
        : (await taskEdges(workspaceRoot, allProjects, load)).edges
  } catch {
    edges = undefined
  }
  const graph = buildPackageGraph([...allProjects], edges)
  const names = new Set(scope.map((p) => p.name))
  for (const p of scope) for (const d of graph.transitiveDeps(p.name)) names.add(d)
  return allProjects.filter((p) => names.has(p.name))
}

/**
 * One sweep over every config for the two things the loop needs: whether
 * any task declares `inputs.workspaceFiles` — globs with no project
 * prefix, so the whole tree has to be watched — and every project's
 * declared outputs, so their writes are not taken for edits. The run
 * path's load (`loadProjects`): the plugin `project` stage applies, so an
 * output a plugin gave a config-less package is ignored like a declared
 * one, and a pure config is served from its cached evaluation rather than
 * re-evaluated in a worker. A config that fails to load is out of this
 * concern's scope — the run that just happened already said so, or will —
 * and the sweep falls back to the files that do load, one by one.
 */
export async function sweepConfigs(
  projects: readonly ProjectMeta[],
  workspaceRoot: string,
  load: CliLoadOptions = {},
): Promise<{
  workspaceWide: boolean
  workspaceInputs: string[]
  outputs: Map<string, string[]>
  /** The staged load the sweep read, when the run path's load succeeded; `watchedProjects` reads the same one. */
  staged: Map<string, ProjectEntry> | null
}> {
  const outputs = new Map<string, string[]>()
  const add = (dir: string, globs: readonly string[] | undefined): void => {
    if (globs === undefined || globs.length === 0) return
    outputs.set(dir, [...(outputs.get(dir) ?? []), ...globs])
  }
  const workspaceInputs = new Set<string>()
  const fold = (dir: string, config: ProjectConfig): void => {
    for (const task of Object.values(config.tasks ?? {})) {
      for (const g of task.cache?.inputs?.workspaceFiles ?? []) workspaceInputs.add(g)
      add(dir, task.cache?.outputs?.files)
      add(workspaceRoot, task.cache?.outputs?.workspaceFiles)
    }
  }
  const result = (
    staged: Map<string, ProjectEntry> | null,
  ): {
    workspaceWide: boolean
    workspaceInputs: string[]
    outputs: Map<string, string[]>
    staged: Map<string, ProjectEntry> | null
  } => ({
    workspaceWide: workspaceInputs.size > 0,
    workspaceInputs: [...workspaceInputs],
    outputs,
    staged,
  })
  let staged: Map<string, ProjectEntry> | null = null
  try {
    staged = await loadCliProjects(workspaceRoot, projects, 'all', load)
  } catch {
    staged = null
  }
  if (staged !== null) {
    for (const p of staged.values()) fold(p.dir, p.config)
    return result(staged)
  }
  await Promise.all(
    projects.map(async (p) => {
      if (p.configPath === null) return
      try {
        fold(p.dir, await loadProjectConfig(p.configPath))
      } catch {
        // broken config — out of this concern's scope
      }
    }),
  )
  return result(null)
}

/**
 * Under the recursive root watcher, the events that can move a key. The
 * watcher hears every write in the workspace; a key can see three kinds
 * of path and no other: a file inside a project's directory (its own
 * `inputs.files`, or its outputs, which the ignore filter drops next), a
 * workspace fingerprint file at the root, and a match of a declared
 * `inputs.workspaceFiles` glob. Everything else — a log written at the
 * root, a `coverage/` or `.turbo/` tree, an editor's scratch file — is
 * dropped before the trigger, so it costs no cycle. Before this rule the
 * one Turbo idiom that puts every repo on this watcher
 * (`globalDependencies` → `workspaceFiles`) made `vx watch … > build.log`
 * inside the repo a loop that never settled: each cycle's output grew the
 * log, the log was an event, the event was a cycle. Negated globs are not
 * consulted: a `!` only narrows, and an event it would have excluded costs
 * one cache-hit cycle, which is the wrong direction to be clever in.
 */
export function makeRootEventFilter(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceInputs: readonly string[],
): (filename: string) => boolean {
  const dirs = projectDirs.map((d) => path.resolve(d))
  const globs = workspaceInputs
    .map(normalizeGlob)
    .filter((g) => !g.startsWith('!'))
    .map((g) => new Bun.Glob(g))
  return (filename: string): boolean => {
    const rel = filename.split(path.sep).join('/')
    if (!rel.includes('/') && (isWorkspaceFingerprintFile(rel) || isWorkspaceConfigFile(rel))) {
      return true
    }
    const abs = path.resolve(workspaceRoot, filename)
    for (const d of dirs) if (abs === d || abs.startsWith(d + path.sep)) return true
    for (const g of globs) if (g.match(rel)) return true
    return false
  }
}

interface WatchLoopArgs {
  opts: RunOptions
  /** Aborted by the SIGINT/SIGTERM handlers `watchCmd` installed; the loop drains its cycle and resolves. */
  stop: AbortSignal
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  workspaceWide: boolean
  /** Every project's directory, in scope or not — under the root watcher an edit there is an edit. */
  projectDirs: readonly string[]
  /** Every declared `inputs.workspaceFiles` glob, root-relative. */
  workspaceInputs: readonly string[]
  /** Absolute, already-resolved — the loop must never re-derive it. */
  cacheDir: string
  /** Declared output globs per directory they are relative to (project dir, or the root for `workspaceFiles`). */
  outputs: ReadonlyMap<string, readonly string[]>
  /** The directory each `<dir>/*` package glob names; a member coming or going there is a cycle. */
  memberBases: readonly string[]
  /** The watched set again, after a cycle that followed a member event. */
  rediscover: () => Promise<Rediscovered>
}

interface Rediscovered {
  projects: readonly ProjectMeta[]
  workspaceInputs: readonly string[]
  outputs: ReadonlyMap<string, readonly string[]>
}

async function runWatchLoop(args: WatchLoopArgs): Promise<number> {
  const { opts, stop, workspaceRoot, projects, workspaceWide, cacheDir, memberBases } = args
  // The watched set as of the last cycle: `rearm` replaces these when a
  // member came or went, and every filter below reads the current one.
  let projectDirs = args.projectDirs
  let workspaceInputs = args.workspaceInputs
  let outputs = args.outputs

  // Reentrancy guard — never two orchestrator runs in flight. Events that
  // land while one is running wait in `pendingPaths` and are judged, on
  // settled bytes, one debounce window after it ends.
  let running = false
  /** The cycle in flight, so the stop path can wait for its teardown before resolving. */
  let inFlight: Promise<void> = Promise.resolve()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Declared outputs are ignored by PATH above. A task with no `cache`
  // block declares none and still writes into its project, and the
  // watcher sees the write: run 1 writes dist/x, the event re-runs, run 2
  // writes the same bytes, the event re-runs — forever (the init
  // walkthrough, 2026-09-04: every fresh workspace, since `init` emits no
  // cache block). An undeclared write is caught by STATE, judged on what
  // has settled (see `trigger`): a path whose settled state equals what
  // this loop last saw for it is not a change. A file's state is its
  // bytes; a directory's is its entries' names and sizes (a nested edit
  // arrives as that path's own event); a path that is gone is one more
  // state. A real edit changes the state; a first sighting passes through.
  // So `rm -rf dist && tsc` — the shape of most build scripts — settles
  // to the same `dist` it left and is one redundant cycle, not a loop
  // (2026-09-10: 780 executions in two minutes from one edit, when a
  // deletion and a directory each passed the gate unconditionally).
  const ABSENT = -1n
  const lastState = new Map<string, bigint>()
  const settledState = (abs: string): bigint => {
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return ABSENT
    }
    if (!st.isDirectory()) {
      try {
        return xxh3(fs.readFileSync(abs))
      } catch {
        return ABSENT
      }
    }
    const entries: string[] = []
    try {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        let size = 0
        if (e.isFile()) {
          try {
            size = fs.statSync(path.join(abs, e.name)).size
          } catch {
            size = -1
          }
        }
        entries.push(`${e.name}\0${e.isDirectory() ? 'd' : size}`)
      }
    } catch {
      return ABSENT
    }
    entries.sort()
    return xxh3(Buffer.from(entries.join('\n')))
  }
  const sameState = (abs: string): boolean => {
    const state = settledState(abs)
    const prev = lastState.get(abs)
    lastState.set(abs, state)
    return prev === state
  }

  // Paths that fired since the last judgement, first label wins. The state
  // check runs when the timer fires, on SETTLED state: per event it is
  // wrong on Linux, where a shell redirect truncates the file (one event,
  // empty) and then writes it (another, full), so consecutive events never
  // agree and a self-write loops anyway (CI, 2026-09-04: 9 re-runs where
  // macOS, which coalesces the two, saw 2). While a cycle runs, nothing is
  // judged: the run's own writes are mid-flight (a `dist` deleted and not
  // yet rebuilt is a state the tree will not keep), so the paths wait and
  // are judged one window after the run ends, all together — an edit made
  // meanwhile still differs from what the loop last saw and re-runs.
  const pendingPaths = new Map<string, string>()
  const judge = (): string | undefined => {
    let first: string | undefined
    for (const [p, l] of pendingPaths) {
      if (!sameState(p)) first ??= l
    }
    pendingPaths.clear()
    return first
  }
  const trigger = (label: string, abs: string): void => {
    if (!pendingPaths.has(abs)) pendingPaths.set(abs, label)
    if (running) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (running) return
      const first = judge()
      if (first !== undefined) void cycle(first)
    }, DEBOUNCE_MS)
  }

  const cycle = async (label: string): Promise<void> => {
    if (stop.aborted || running) return
    running = true
    const done = (inFlight = runCycle(label))
    await done
  }
  const runCycle = async (first: string): Promise<void> => {
    try {
      let label: string | undefined = first
      while (label !== undefined && !stop.aborted) {
        process.stdout.write(`\nvx watch: ${label}; re-running...\n\n`)
        try {
          await runOrchestrator(opts)
          if (membersChanged && !stop.aborted) {
            membersChanged = false
            await rearm()
          }
        } catch (err) {
          // A re-run can fail catastrophically when the workspace
          // itself moved out from under us — e.g. the user deleted
          // the project dir, or git lost its repo (the watch loop
          // outlives its own cwd in test teardown). Surface the
          // message but DON'T let it crash the watch loop; the next
          // FS event (if any) will retry. The dispose() on SIGINT
          // is the canonical exit; we don't unilaterally abort here.
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`vx watch: cycle failed: ${message}\n`)
        }
        // What landed mid-run is judged on settled state, one window
        // after the run, under the label of what actually arrived.
        if (pendingPaths.size === 0 || stop.aborted) break
        await Bun.sleep(DEBOUNCE_MS)
        label = judge()
      }
    } finally {
      running = false
      // Anything that landed after the last judgement waits for a timer
      // like any other event.
      if (pendingPaths.size > 0 && !stop.aborted) {
        const [abs, label] = [...pendingPaths][0]!
        trigger(label, abs)
      }
    }
  }

  // Filter out events for paths we don't care about. We watch each
  // project's dir recursively, so a `node_modules` write under a
  // project would otherwise trigger every save during `bun install` —
  // and vx's own cache writes would trigger a cycle that writes again.
  let isIgnoredPath = makeWatchIgnore(cacheDir, outputs)
  let matters = makeRootEventFilter(workspaceRoot, projectDirs, workspaceInputs)
  /** A member came or went under a package glob's directory since the last cycle. */
  let membersChanged = false

  const watchers: WatchHandle[] = []
  const proofs: Promise<void>[] = []
  // `VX_WATCH_POLL=1` skips the OS watcher entirely. Where it is known not
  // to work — a sandbox with no `machLookup` for `com.apple.FSEvents`, a
  // network mount, a container bind — the attempt costs a denied syscall
  // and a two-second wait before the fallback takes over anyway.
  const forcePoll = (process.env['VX_WATCH_POLL'] ?? '') !== ''
  const arm = (dir: string, recursive: boolean, onEvent: (filename: string) => void): void => {
    if (forcePoll) {
      watchers.push(pollWatcher(dir, recursive, onEvent))
      return
    }
    const armed = armWatcher(dir, recursive, onEvent)
    watchers.push(armed.watcher)
    proofs.push(
      armed.ready.then((ok) => {
        if (ok) return
        // The watcher never proved delivery, so it is not one: an FSEvents
        // stream the OS refused, a filesystem that reports nothing. Swap in
        // the poller rather than run a loop that silently never fires.
        armed.watcher.close()
        watchers[watchers.indexOf(armed.watcher)] = pollWatcher(dir, recursive, onEvent)
        process.stderr.write(
          `vx watch: ${dir}: no OS watch events within ${WATCH_PROBE_TIMEOUT_MS} ms; polling every ${POLL_INTERVAL_MS} ms instead\n`,
        )
      }),
    )
  }

  /** Per-project arms by directory, so `rearm` can add and drop them. */
  const perProject = new Map<string, WatchHandle>()
  const armProject = (proj: ProjectMeta): void => {
    try {
      const at = watchers.length
      arm(proj.dir, true, (filename) => {
        if (isIgnoredPath(proj.dir, filename)) return
        trigger(`${proj.name} ${filename}`, path.join(proj.dir, filename))
      })
      // By slot, not by handle: an OS watcher that never proves delivery is
      // swapped for a poller in place, and a drop must close what is there.
      perProject.set(proj.dir, { close: () => watchers[at]?.close() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch ${proj.dir}: ${msg}\n`)
    }
  }
  const rearm = async (): Promise<void> => {
    let next: Rediscovered
    try {
      next = await args.rediscover()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot re-read the workspace: ${msg}\n`)
      return
    }
    projectDirs = next.projects.map((p) => p.dir)
    workspaceInputs = next.workspaceInputs
    outputs = next.outputs
    isIgnoredPath = makeWatchIgnore(cacheDir, outputs)
    matters = makeRootEventFilter(workspaceRoot, projectDirs, workspaceInputs)
    if (!workspaceWide) {
      const keep = new Set(projectDirs)
      for (const [dir, handle] of perProject) {
        if (keep.has(dir)) continue
        handle.close()
        perProject.delete(dir)
      }
      for (const proj of next.projects) if (!perProject.has(proj.dir)) armProject(proj)
      // A new arm proves delivery like the first ones: an edit in the new
      // package right after this cycle is seen, not lost in the gap.
      await Promise.all(proofs)
    }
    process.stdout.write(`vx watch: watching ${next.projects.length} project(s)\n`)
  }

  if (workspaceWide) {
    // workspaceFiles inputs in play: a root-relative glob can name a
    // file anywhere, so one recursive root watcher replaces the
    // per-project ones (it also covers lockfile / pnpm-workspace.yaml
    // edits). `matters` keeps the events a key can see — project
    // trees, root fingerprint files, the declared globs — and drops the
    // rest of the tree; the ignore filter then keeps node_modules /
    // .git / .vx and declared outputs out of what remains.
    try {
      arm(workspaceRoot, true, (filename) => {
        if (!matters(filename) || isIgnoredPath(workspaceRoot, filename)) return
        trigger(`root ${filename}`, path.join(workspaceRoot, filename))
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch workspace root: ${msg}\n`)
    }
  } else {
    // One recursive watcher per project. Each project owns its own
    // subtree; we don't watch the workspace root recursively (would
    // cover every project + node_modules + caches).
    for (const proj of projects) armProject(proj)

    // Plus the workspace root itself (non-recursive) so lockfile +
    // pnpm-workspace.yaml edits trigger re-runs even when no project
    // dir saw the change.
    try {
      arm(workspaceRoot, false, (filename) => {
        if (isWorkspaceFingerprintFile(filename) || isWorkspaceConfigFile(filename)) {
          trigger(`root ${filename}`, path.join(workspaceRoot, filename))
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch workspace root: ${msg}\n`)
    }
  }

  // A package added while the loop runs is a directory entry appearing
  // under the glob's directory (`packages/` for `packages/*`); one
  // non-recursive watcher there hears it come or go, and the cycle it
  // triggers re-reads the workspace (`rearm`) so the new package's own
  // edits are cycles from then on. Until 2026-09-10 the watched set was
  // fixed when the loop armed: the next cycle ran the new package, and
  // every edit inside it after that was silence.
  for (const base of memberBases) {
    let members = memberEntries(base)
    try {
      arm(base, false, (filename) => {
        if (isIgnoredWatchPath(filename)) return
        // Only a member coming or going. On macOS a non-recursive watcher
        // also reports a member whose CONTENTS changed (FSEvents names the
        // directory a write landed in), so a task writing into its own
        // project — or the arm's own probe file — read as a member event and
        // cost an uncached task one execution per cycle (CI, 2026-09-10).
        const now = memberEntries(base)
        if (sameMembers(members, now)) return
        members = now
        membersChanged = true
        trigger(`${path.relative(workspaceRoot, base)}/${filename}`, path.join(base, filename))
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch ${base}: ${msg}\n`)
    }
  }

  // The orchestrator's own writes never kick the loop: `makeWatchIgnore`
  // closes over the RESOLVED cache dir (relocated or not) and the tasks'
  // declared outputs.

  // "watching" is a promise that an edit from now on is seen; every
  // watcher has proved (or been given 2 s to prove) delivery first.
  await Promise.all(proofs)

  process.stdout.write(
    workspaceWide
      ? `\nvx watch: watching the workspace root (workspaceFiles inputs in use); press Ctrl+C to stop\n`
      : `\nvx watch: watching ${projects.length} project(s); press Ctrl+C to stop\n`,
  )

  return await new Promise<number>((resolve) => {
    const cleanup = async (): Promise<void> => {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // ignore
        }
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      // The aborted cycle is tearing its children down; resolve only once
      // it has returned, so the process never exits over a live child.
      await inFlight
      resolve(0)
    }
    if (stop.aborted) {
      void cleanup()
      return
    }
    stop.addEventListener('abort', () => void cleanup(), { once: true })
  })
}

/**
 * The directory entries under a package glob's directory that can be
 * members: directories (or links) whose name is not dotted and not
 * `node_modules`, the same rule discovery applies. A watcher on that
 * directory reacts only when this set changes.
 */
export function memberEntries(base: string): ReadonlySet<string> {
  const out = new Set<string>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isDirectory() || e.isSymbolicLink()) out.add(e.name)
  }
  return out
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const name of a) if (!b.has(name)) return false
  return true
}

/**
 * True for a root file that re-keys EVERY task, so a change to one must trigger
 * a cycle even though it lives in no project dir.
 *
 * Reads the SHARED constant the fingerprint itself walks — this used to be a
 * third hand-rolled copy of that list, which is precisely the drift the
 * `--affected` wave exported the constant to prevent. A name added there but
 * not here would re-key every task while `vx watch` silently never re-ran on
 * it: the loop looks alive, and the one edit that invalidates the whole
 * workspace is the one it ignores.
 */
const FINGERPRINT_FILES: ReadonlySet<string> = new Set(WORKSPACE_FINGERPRINT_FILES)

function isWorkspaceFingerprintFile(name: string): boolean {
  return FINGERPRINT_FILES.has(name)
}

/**
 * The workspace config is the one root file that shapes a run without
 * being any task's input — its plugins, `config` stage, concurrency, cache
 * dir — and a cycle re-evaluates it (its import is keyed on its bytes).
 * Until 2026-09-10 neither root arm listened for it: a plugin added under
 * `vx watch` waited for a restart while the loop looked alive.
 */
const WORKSPACE_CONFIGS: ReadonlySet<string> = new Set(WORKSPACE_CONFIG_FILENAMES)

function isWorkspaceConfigFile(name: string): boolean {
  return WORKSPACE_CONFIGS.has(name)
}
