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
import { xxh3 } from '../util/index.js'
import { parseRunArgs, resolveRunOptions } from './run.js'
import { run as runOrchestrator, type RunOptions } from '../orchestrator/index.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  loadWorkspaceConfig,
  resolveCacheDir,
  WORKSPACE_FINGERPRINT_FILES,
  type ProjectMeta,
} from '../workspace/index.js'

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
  const declared = [...outputs].map(
    ([dir, globs]) => [path.resolve(dir), globs.map((g) => new Bun.Glob(g))] as const,
  )
  return (base, filename) => {
    if (isIgnoredWatchPath(filename)) return true
    const abs = path.resolve(base, filename)
    if (abs === cacheAbs || abs.startsWith(cacheAbs + path.sep)) return true
    for (const [dir, globs] of declared) {
      if (!abs.startsWith(dir + path.sep)) continue
      const rel = abs
        .slice(dir.length + 1)
        .split(path.sep)
        .join('/')
      if (globs.some((g) => g.match(rel))) return true
    }
    return false
  }
}

/**
 * The file `armWatcher` writes under a watched directory to prove the
 * watcher delivers. Intercepted by name before any other handling, so it
 * can never trigger a cycle, and removed before "watching" is printed.
 */
export const WATCH_PROBE = '.vx-watch-probe'

/** How long a watcher gets to report its own probe before the loop goes on without proof. */
const WATCH_PROBE_TIMEOUT_MS = 2_000

export interface ArmedWatcher {
  watcher: fs.FSWatcher
  /** Resolves `true` once the watcher reported the probe, `false` on timeout. */
  ready: Promise<boolean>
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
  // The watch loop owns SIGINT/SIGTERM for its whole lifetime (the
  // process.once handlers below close watchers and resolve 0). A
  // cycle's run() must not install its exit-the-process handlers —
  // Ctrl-C mid-cycle would kill the loop with 130 instead of the
  // loop's own clean shutdown.
  const opts: RunOptions = { ...resolved, handleSignals: false }

  // Enumerate projects-in-scope so we know what dirs to watch.
  // `opts.projects` is the resolved scope; undefined means "every
  // project". We watch only those (plus the workspace root, for
  // lockfile changes).
  const workspaceRoot = await findWorkspaceRoot(cwd)
  const allProjects = await listProjects(await loadWorkspace(workspaceRoot))
  const scope =
    opts.projects === undefined
      ? allProjects
      : allProjects.filter((p) => opts.projects!.includes(p.name))

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

  const swept = await sweepConfigs(allProjects, workspaceRoot)
  return await runWatchLoop({
    opts,
    workspaceRoot,
    projects: scope,
    workspaceWide: swept.workspaceWide,
    outputs: swept.outputs,
    // The RESOLVED cache dir, not the `.vx` literal — see `makeWatchIgnore`.
    cacheDir:
      opts.cacheDir ?? resolveCacheDir(workspaceRoot, await loadWorkspaceConfig(workspaceRoot)),
  })
}

/**
 * One sweep over every config for the two things the loop needs: whether
 * any task declares `inputs.workspaceFiles` — globs with no project
 * boundary, so the per-project watchers can't see all triggering paths
 * and the loop switches to one recursive root watcher — and each
 * project's declared outputs, so their writes are not taken for edits.
 * Checked across ALL projects (not just the scope) because dependsOn can
 * pull tasks from anywhere; a broken out-of-scope config is skipped,
 * matching scoped-run semantics (it surfaces when that project enters
 * scope).
 */
async function sweepConfigs(
  projects: readonly ProjectMeta[],
  workspaceRoot: string,
): Promise<{ workspaceWide: boolean; outputs: Map<string, string[]> }> {
  const outputs = new Map<string, string[]>()
  const add = (dir: string, globs: readonly string[] | undefined): void => {
    if (globs === undefined || globs.length === 0) return
    outputs.set(dir, [...(outputs.get(dir) ?? []), ...globs])
  }
  // Concurrent, not sequential: the run that just happened already
  // loaded the in-scope configs, so these are REPEAT loads that
  // re-evaluate in a worker. Issuing them together lets one worker
  // serve the whole sweep instead of one per project.
  const uses = await Promise.all(
    projects.map(async (p): Promise<boolean> => {
      if (p.configPath === null) return false
      try {
        const config = await loadProjectConfig(p.configPath)
        let wide = false
        for (const task of Object.values(config.tasks ?? {})) {
          if ((task.cache?.inputs?.workspaceFiles?.length ?? 0) > 0) wide = true
          add(p.dir, task.cache?.outputs?.files)
          add(workspaceRoot, task.cache?.outputs?.workspaceFiles)
        }
        return wide
      } catch {
        // broken config — out of this concern's scope
        return false
      }
    }),
  )
  return { workspaceWide: uses.includes(true), outputs }
}

interface WatchLoopArgs {
  opts: RunOptions
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  workspaceWide: boolean
  /** Absolute, already-resolved — the loop must never re-derive it. */
  cacheDir: string
  /** Declared output globs per directory they are relative to (project dir, or the root for `workspaceFiles`). */
  outputs: ReadonlyMap<string, readonly string[]>
}

async function runWatchLoop(args: WatchLoopArgs): Promise<number> {
  const { opts, workspaceRoot, projects, workspaceWide, cacheDir, outputs } = args

  // Reentrancy guard — never two orchestrator runs in flight. While
  // one is running, any further events set `pending = true` and the
  // loop drains it after the current run finishes.
  let running = false
  let pending = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Declared outputs are ignored by PATH above. A task with no `cache`
  // block declares none and still writes into its project, and the
  // watcher sees the write: run 1 writes dist/x, the event re-runs, run 2
  // writes the same bytes, the event re-runs — forever (the init
  // walkthrough, 2026-09-04: every fresh workspace, since `init` emits no
  // cache block). An undeclared write is caught by CONTENT, at debounce
  // time (see `trigger`): a path whose settled bytes equal what this loop
  // last hashed for it is not a change. A real edit changes the bytes; a deletion, a directory or a
  // first sighting passes through (so the loop costs one redundant run,
  // not an unbounded number).
  const lastBytes = new Map<string, bigint>()
  const sameBytes = (abs: string): boolean => {
    let hash: bigint
    try {
      hash = xxh3(fs.readFileSync(abs))
    } catch {
      lastBytes.delete(abs)
      return false
    }
    const prev = lastBytes.get(abs)
    lastBytes.set(abs, hash)
    return prev === hash
  }

  // Paths that fired during the debounce window, first label wins. The
  // content check runs when the timer fires, on SETTLED bytes: per event it
  // is wrong on Linux, where a shell redirect truncates the file (one event,
  // empty) and then writes it (another, full), so consecutive events never
  // agree and a self-write loops anyway (CI, 2026-09-04: 9 re-runs where
  // macOS, which coalesces the two, saw 2).
  const pendingPaths = new Map<string, string>()
  const trigger = (label: string, abs: string): void => {
    if (!pendingPaths.has(abs)) pendingPaths.set(abs, label)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      let first: string | undefined
      for (const [p, l] of pendingPaths) {
        if (!sameBytes(p)) first ??= l
      }
      pendingPaths.clear()
      if (first !== undefined) void cycle(first)
    }, DEBOUNCE_MS)
  }

  const cycle = async (label: string): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      do {
        pending = false
        process.stdout.write(`\nvx watch: ${label}; re-running...\n\n`)
        try {
          await runOrchestrator(opts)
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
        // If a change arrived mid-run, loop again immediately.
      } while (pending)
    } finally {
      running = false
    }
  }

  // Filter out events for paths we don't care about. We watch each
  // project's dir recursively, so a `node_modules` write under a
  // project would otherwise trigger every save during `bun install` —
  // and vx's own cache writes would trigger a cycle that writes again.
  const isIgnoredPath = makeWatchIgnore(cacheDir, outputs)

  const watchers: fs.FSWatcher[] = []
  const proofs: Promise<void>[] = []
  const arm = (dir: string, recursive: boolean, onEvent: (filename: string) => void): void => {
    const armed = armWatcher(dir, recursive, onEvent)
    watchers.push(armed.watcher)
    proofs.push(
      armed.ready.then((ok) => {
        if (!ok) {
          process.stderr.write(
            `vx watch: ${dir}: the watcher gave no sign of life within ${WATCH_PROBE_TIMEOUT_MS} ms; early edits there may be missed\n`,
          )
        }
      }),
    )
  }

  if (workspaceWide) {
    // workspaceFiles inputs in play: any file in the workspace can be
    // an input, so one recursive root watcher replaces the per-project
    // ones (it also covers lockfile / pnpm-workspace.yaml edits). The
    // ignore filter keeps node_modules / .git / .vx churn out; edits
    // outside any task's inputs still cost only a cache-hit cycle.
    try {
      arm(workspaceRoot, true, (filename) => {
        if (isIgnoredPath(workspaceRoot, filename)) return
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
    for (const proj of projects) {
      try {
        arm(proj.dir, true, (filename) => {
          if (isIgnoredPath(proj.dir, filename)) return
          trigger(`${proj.name} ${filename}`, path.join(proj.dir, filename))
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`vx watch: cannot watch ${proj.dir}: ${msg}\n`)
      }
    }

    // Plus the workspace root itself (non-recursive) so lockfile +
    // pnpm-workspace.yaml edits trigger re-runs even when no project
    // dir saw the change.
    try {
      arm(workspaceRoot, false, (filename) => {
        if (isWorkspaceFingerprintFile(filename)) {
          trigger(`root ${filename}`, path.join(workspaceRoot, filename))
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch workspace root: ${msg}\n`)
    }
  }

  // The orchestrator's writes into `.vx/cache/` don't trigger
  // re-runs because IGNORED_SEGMENTS includes `.vx`. Users who
  // relocate the cache dir outside `.vx/` need their own filtering.

  // "watching" is a promise that an edit from now on is seen; every
  // watcher has proved (or been given 2 s to prove) delivery first.
  await Promise.all(proofs)

  process.stdout.write(
    workspaceWide
      ? `\nvx watch: watching the workspace root (workspaceFiles inputs in use); press Ctrl+C to stop\n`
      : `\nvx watch: watching ${projects.length} project(s); press Ctrl+C to stop\n`,
  )

  return await new Promise<number>((resolve) => {
    const cleanup = (): void => {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // ignore
        }
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      resolve(0)
    }
    process.once('SIGINT', () => {
      process.stdout.write('\nvx watch: stopped\n')
      cleanup()
    })
    process.once('SIGTERM', cleanup)
  })
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
