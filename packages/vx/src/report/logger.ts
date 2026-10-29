import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { settingEnv } from '../settings.js'
import {
  formatFrameClose,
  formatFrameOpen,
  formatKeptLines,
  formatPersistentTailBlock,
  formatListHeader,
  formatTaskAbortedLine,
  formatTaskBlock,
  formatTaskExecutedLine,
  flakyNote,
  pathNote,
  whereNote,
  formatTaskHashLine,
  formatTaskHitLine,
  formatTaskSkippedLine,
  type OutputChunk,
} from './framed-output.js'
import {
  createOutputWriter,
  formatFailureLine,
  formatStatusRegion,
  formatStepLine,
  type StatusStream,
  type WorkerSlot,
} from './status-line.js'
import {
  cacheBucketOf,
  formatSummarySection,
  neverStarted,
  ranUnsaved,
  type RunContext,
  type TaskBucket,
} from './summary.js'
import { isGroupTask } from '../graph/index.js'
import {
  appendTail,
  createTail,
  formatElapsed,
  resetTail,
  tailText,
  type Tail,
  detectColors,
  envFlagOn,
  type ColorSupport,
  ui,
} from '../util/index.js'
import { isCacheHit } from '../graph/index.js'
import { failedLabel, outcomeWord, ranNoCache } from './events.js'
import type { BlockedTask, Forecast } from './forecast.js'
import {
  notifyEscape,
  PROGRESS_CLEAR,
  progressEscape,
  terminalLinks,
  terminalSignals,
} from './terminal-signals.js'

export interface Logger {
  /** Header / footer / status text. Written verbatim, one trailing \n added. */
  status(line: string): void
  /**
   * A warning: something worked, but look at it. The default logger writes
   * it to stderr, so stdout carries only the rows and the footer. A logger
   * without it gets warnings through `status`.
   */
  warn?(line: string): void
  /** Streamed stdout chunk for a task. Buffered until `taskComplete`. */
  taskStdout(node: TaskNode, chunk: string): void
  /** Streamed stderr chunk for a task. Buffered until `taskComplete`. */
  taskStderr(node: TaskNode, chunk: string): void
  /**
   * Flush a task's buffered output as one framed block. Called once
   * per task on completion (success, failure, cache hit, or skip).
   */
  taskComplete(node: TaskNode, outcome: TaskOutcome): void
  /**
   * Optional lifecycle hooks. The orchestrator calls them when
   * present; the default logger uses them to drive its dynamic
   * status line. Custom loggers can ignore them.
   */
  runStart?(info: {
    total: number
    concurrency?: number
    requestedCount?: number
    /** Run banner context — so the live region footer matches the final summary. */
    context?: RunContext
    /** The run's canonical start (epoch ms) — equals the final summary's `startedAt`. */
    startedAtMs?: number
  }): void
  taskStart?(node: TaskNode): void
  /** The task graph finished (any outcome); vx's own closing steps follow. Idempotent. */
  runEnd?(): void
  /**
   * One of vx's own steps (`vx:keys`, `@vzn/vx-otel:setup`) began or ended.
   * Not a task: no stat, history row or telemetry record counts it.
   */
  stepStart?(id: string): void
  stepEnd?(id: string, info: { durationMs: number; ok: boolean }): void
  /** The run was stopped (a signal, an embedder's abort); its tasks are going down. Idempotent. */
  runStop?(): void
  /** The run's work is done; the footer follows. Idempotent. */
  runDone?(): void
}

/** `log.warn`, or `log.status` for a logger without it. */
export function warnOf(log: Logger): (line: string) => void {
  return log.warn !== undefined ? (line) => log.warn!(line) : (line) => log.status(line)
}

/** The logger `run()` builds when none is passed. */
export interface DefaultLogger extends Logger {
  /**
   * Hand over any output still coalesced, and write straight through from
   * now on. `runEnd` does it; the run's own `finally` does it again for a
   * throw that never reached `runEnd`.
   */
  settle(): void
  /**
   * Whether vx's own steps show: only beside a live region, on a terminal.
   * A log (CI, a pipe) stays free of rows whose presence is a timing.
   * When false, run() never times a step (zero cost).
   */
  readonly showsSteps: boolean
  /**
   * Hand the live region the run's forecast. Called once at run start:
   * `graph` (the graph alone: what is blocked, and by what) is built the
   * first time a worker row is free; `load` adds history's timings, and
   * runs only if the region is still live a second in, so a run that ends
   * sooner never reads history for it.
   */
  forecast(graph: () => Forecast, load: () => Promise<Forecast>): void
  /** Draw no live region until the returned release: a prompt waits on the terminal. */
  holdStatus(): () => void
}

/**
 * The default logger's per-task output policy. Resolved once per run
 * from (in priority order) the explicit `--output-logs` override, a
 * truthy `CI` env, and the CLI-detected flow:
 *
 *   full        — frames for executed work, one-liners for quiet hits.
 *                 Today's CI behavior; also the programmatic default.
 *   errors-only — only failed tasks print.
 *   none        — no per-task output at all.
 *   hash-only   — one line per task: outcome word, task id, cache key.
 *                 No frames, no log replay (Turbo `--output-logs
 *                 hash-only` parity); the end-of-run summary still
 *                 renders. The line is the run's audit trail: which key
 *                 each task resolved to, without any build output.
 *   focused     — requested nodes stream raw output live (running the
 *                 task should feel like running the command directly);
 *                 dependency-pulled nodes are silent unless they fail.
 *   broad       — news only: one `success` line per executed task,
 *                 full frames for failures, silence for cache hits.
 *
 * `gha` (on GitHub Actions, any mode): task output is fenced from
 * workflow commands. In full mode each task's block is also wrapped in
 * `::group::` / `::endgroup::` so tasks collapse in the log viewer —
 * except failed tasks, which stay pre-expanded and emit an `::error`
 * annotation instead.
 *
 * `ci`: a truthy CI env was detected. Suppresses the dynamic status
 * line even if stdout happens to be a TTY.
 */
export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean
  ci?: boolean
}

// ── GitHub Actions workflow-command escaping ────────────────────────
// The runner parses `::`-prefixed LINES out of the log, so anything
// interpolated into one has to be encoded or it changes the command's shape.
// Both halves are reachable without malice: a task name is an arbitrary TS
// object key (the loader accepts newlines — `run-report.ts` already escapes
// them for the same reason), and a task can legitimately print
// command-shaped text (a test asserting on annotation formatting, a nested
// tool emitting its own workflow commands).
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions

/** Message text. `%` first, or we would re-escape our own escapes. */
function ghaData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * A property VALUE additionally reserves `:` and `,` — the delimiters
 * between a command's name, its properties and its message. Without this an
 * id containing `::` truncates the annotation mid-title.
 */
function ghaProperty(value: string): string {
  return ghaData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

/**
 * Fence untrusted text so the runner stops interpreting workflow commands
 * inside it. `token` must be unguessable by the fenced text itself — a fixed
 * one could simply be printed by the task — so it is a per-run UUID.
 */
function ghaFence(body: string, token: string): string {
  return `::stop-commands::${token}\n${body}::${token}::\n`
}

const cacheWordOf = (o: TaskOutcome): 'miss' | 'no-cache' => (ranNoCache(o) ? 'no-cache' : 'miss')

export function resolveOutputView(
  options: {
    outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
    flow?: 'focused' | 'broad'
  },
  env: Record<string, string | undefined> = process.env,
): OutputView {
  const ci = envFlagOn(env['CI'])
  const gha = envFlagOn(env['GITHUB_ACTIONS'])
  const mk = (mode: OutputView['mode']): OutputView => ({
    mode,
    ...(gha ? { gha: true } : {}),
    ...(ci ? { ci: true } : {}),
  })
  // `run.outputLogs`: chosen before the workspace loads, so flag, then variable.
  const outputLogs =
    options.outputLogs ?? (settingEnv('run.outputLogs', env) as OutputView['mode'] | undefined)
  if (outputLogs !== undefined) return mk(outputLogs)
  if (ci) return mk('full')
  if (options.flow !== undefined) return mk(options.flow)
  return mk('full')
}

/** A run shorter than this never reads history for a forecast. */
const FORECAST_AFTER_MS = 1000
/** A run shorter than this ends without a desktop notification. */
const NOTIFY_AFTER_MS = 10_000
// A step of vx's own quicker than this shows nowhere (2026-10-15).
const STEP_SHOWN_MS = 150

export function defaultLogger(
  colors: ColorSupport = detectColors(),
  view: OutputView = { mode: 'full' },
  out: StatusStream = process.stdout,
  opts: {
    forceFloorMs?: number
    coalesce?: boolean
    tty?: boolean
    /** The args after `--`: a requested task's `$ <command>` line shows them, as it ran. */
    forwardArgs?: readonly string[]
    /** `false`: no summary in the live region and no blank line opening the log (`RunOptions.footer`). */
    footer?: boolean
    /** The environment that names the terminal (`TERM_PROGRAM`, …); `process.env` by default. */
    env?: Readonly<Record<string, string | undefined>>
    /** Where warnings go; `process.stderr` by default. */
    err?: StatusStream
  } = {},
): DefaultLogger {
  const forwardArgs = opts.forwardArgs ?? []
  const errOut = opts.err ?? process.stderr
  // Per-task buffers, split by stream. Splitting lets the framed-output
  // renderer put stdout under `├─ stdout` and stderr under `├─ stderr`.
  // The price: chunks that interleaved at runtime get re-ordered (all
  // stdout before all stderr).
  //
  // Chunks are held as a string[] (push + join on flush) instead of
  // appending via `+=`; concatenating N small chunks via `+=` is O(N²)
  // because each `+=` allocates a fresh string of the full accumulated
  // length. Bun-friendly: join('') is a single contiguous allocation.
  const outputBuffers = new Map<string, OutputChunk[]>()
  // Separator bookkeeping: blocks are blank-line-delimited on BOTH
  // sides — raw (unprefixed) frame content must never collide with a
  // neighbouring one-liner (owner feedback). A block leaves its own
  // trailing blank, so a block following a block needs no leading one;
  // a one-liner or streamed output since the last block does.
  let lineEmitted = false
  let streamedSinceBlock = false
  // True while the live stream sits mid-line (chunk without trailing
  // newline) — the frame close must not glue onto partial output.
  let streamMidLine = false
  const pushChunk = (id: string, text: string, err: boolean): void => {
    const arr = outputBuffers.get(id)
    if (arr) arr.push({ text, err })
    else outputBuffers.set(id, [{ text, err }])
  }
  const takeChunks = (id: string): OutputChunk[] => {
    const arr = outputBuffers.get(id)
    if (!arr) return []
    outputBuffers.delete(id)
    return arr
  }

  // `none` is the ONE mode whose contract guarantees the output is
  // discarded — "no per-task output at all" (docs/cli.md) — so its chunks
  // are dropped on arrival instead of accumulated and thrown away at
  // `taskComplete`. Buffering output the mode promises never to print made
  // `--output-logs none`, the obvious mitigation for a chatty task, cost
  // exactly as much memory as printing it: 400 MB of task stdout drove the
  // vx process to 852 MiB RSS, unbounded and linear, and a warm CACHE HIT
  // paid it too (the stored stdout is replayed through this same path).
  //
  // Deliberately ONLY the modes that PROMISE never to print task output —
  // `none` and `hash-only`. The boundary is the point: `full`, `broad`,
  // `focused` and `errors-only` all PRINT this output — for `errors-only` a
  // failed task's log is precisely what the user asked to see — and
  // silently truncating someone's build log is a worse failure than the
  // memory it costs. So those modes stay unbounded by decision, not by
  // oversight.
  const discardsOutput = view.mode === 'none' || view.mode === 'hash-only'

  // One per run, and only in GHA mode: the fence token must be something the
  // fenced task output cannot print.
  const ghaToken = view.gha === true ? crypto.randomUUID() : ''
  // A task's own text, fenced on GitHub Actions: the frames `errors-only`
  // and `broad` defer and a server's tail printed a task's `::error::` raw.
  const fenced = (block: string): string =>
    view.gha === true && block.length > 0 ? ghaFence(block, ghaToken) : block

  // All stdout flows through the writer so the status line can never
  // interleave with content. Inert (pure passthrough) on non-TTY
  // streams and in CI.
  const writer = createOutputWriter(out, {
    enabled: view.ci !== true,
    ...(opts.forceFloorMs !== undefined ? { forceFloorMs: opts.forceFloorMs } : {}),
    ...(opts.coalesce === true ? { coalesce: true } : {}),
  })

  // Status-display state, driven by the optional lifecycle hooks.
  let total = 0
  // Live open/close framing only works when ONE requested task owns
  // the terminal between its open and close. With multiple requested
  // tasks streaming concurrently, frames interleave into garbage —
  // so we buffer each requested node and emit an atomic block at
  // completion instead. Default-safe: undefined / 0 / 1 keeps the
  // single-target live experience byte-identical.
  let requestedCount = 1
  // Run banner context — rendered in the live region's summary section
  // so the in-flight footer matches the final summary exactly.
  let runContext: RunContext | undefined
  let done = 0
  let failed = 0
  let startedAtMs = Date.now()
  let ticker: ReturnType<typeof setInterval> | null = null
  let statusDead = !writer.enabled
  // The live run's forecast (live region only). Finished ids feed it; the
  // set is kept only where a region can show the answer.
  const finished = new Set<string>()
  let forecastFn: Forecast | undefined
  let graphForecast: (() => Forecast) | undefined
  let forecastTimer: ReturnType<typeof setTimeout> | null = null
  // When the forecast says the run ends; past it, the region counts up.
  let deadlineMs: number | undefined
  let critical: string | undefined
  // Tasks the region showed on the critical path: their finished rows say so too.
  const onPath = new Set<string>()
  let blockedCount = 0
  let expected: ReadonlyMap<string, number> | undefined
  let blocked: readonly BlockedTask[] | undefined
  let blockedBy: ReadonlyMap<string, number> | undefined
  let etaAtMs = 0
  const signals = writer.enabled
    ? terminalSignals(opts.env ?? process.env)
    : { progress: false, notify: false }
  const links = writer.enabled && terminalLinks(opts.env ?? process.env)
  let progressShown = -1
  let progressRed = false

  // Every interactive view renders the fixed-height running list: one
  // row per worker, sized at runStart from concurrency, so its height
  // never changes; a task keeps its slot for its whole life. Excess
  // running tasks queue for a freed slot, each shown after the slots.
  let slots: (WorkerSlot | null)[] = []
  const slotQueue: WorkerSlot[] = []
  let succeeded = 0
  // Executed with no `cache` block: never a miss, counted apart.
  let noCache = 0
  let upToDate = 0
  let restoredLocal = 0
  let restoredRemote = 0
  let saved = 0
  let notSaved = 0
  let skippedCount = 0
  // Each finished task's cache bucket by its key: its remote traffic moves it.
  const buckets = new Map<string, TaskBucket>()
  // The graph is done and vx's own closing steps run: the region stays,
  // footer and step rows, until the footer replaces it (2026-10-15).
  let tail = false
  // The run was stopped: the region stays, its running rows say
  // `aborting`, and nothing is forecast or held (2026-10-17).
  let stopping = false
  // Counted live once the run is stopping, as the footer counts them.
  let stopped = 0
  let notRun = 0
  // No footer before the run starts: vx's opening steps show alone.
  let started = false
  // vx's own steps running now, by id: a row once one passes STEP_SHOWN_MS.
  const steps = new Map<string, number>()
  // Cache-miss duration spread, accumulated incrementally (the same
  // numbers the final summary computes from the outcome list).
  let spreadMax = 0
  let spreadMin = Infinity
  let spreadSum = 0
  let spreadCount = 0
  // The pinned zone above the worker rows: persistent tasks pin at
  // ready (their outcome lands while the child keeps running) and live
  // until runEnd kills the region. A failure is not pinned: it is a
  // permanent ◼ row the moment it happens, and its full frame is
  // deferred to runEnd (owner: '✗ line, continue, all full frames at
  // the end'). 'full'/CI keeps frames inline.
  const deferredFailures: string[] = []
  // Each ready server's outcome: one whose child has exited (`serverExit`) is no longer pinned.
  const pinnedPersistent: TaskOutcome[] = []
  let flushedFailures = false
  // A persistent task (dev server, watcher, daemon) is the one task kind
  // nothing bounds: a one-shot command's output ends when it exits, but a
  // server writes for as long as the run lasts. So its chunks route into a
  // bounded tail for its WHOLE life, not the unbounded per-task buffers —
  // registered at `taskStart` and drained at `taskComplete` for the frame,
  // then reset to keep capturing what it writes after its outcome landed
  // (which arrives at READY, while the child keeps running) and flushed as
  // one trailing block at runEnd.
  //
  // Registering only at READY was the defect: a `readyWhen` that never
  // matches never reaches `taskComplete`, so the 64 KiB cap never engaged
  // and its output accumulated in the ordinary per-task buffer instead —
  // ~100 MiB/s, with no `exec.timeout` needed to reach it.
  //
  // `outcome` is absent until the task completes. Registration is
  // unconditional (the bound is a memory invariant, not a display choice);
  // only the flush is view-gated.
  const persistentTails = new Map<
    string,
    { node: TaskNode; outcome?: TaskOutcome; out: Tail; err: Tail }
  >()
  let flushedPersistent = false
  // After that flush nothing prints a tail again, yet a kept server writes
  // for as long as vx holds it: `vx run dev --all` showed none of its
  // servers' logs while it ran (C-56). So a ready server's output streams
  // from then on, a line at a time under its id; the partial line each
  // holds waits for its newline, a status line, a second runEnd, or `settle`.
  const KEPT_LINE_CAP = 64 * 1024
  const keptLines = new Map<string, { node: TaskNode; rest: string }>()
  const streamKept = (node: TaskNode, chunk: string): void => {
    const held = keptLines.get(node.id) ?? { node, rest: '' }
    keptLines.set(node.id, held)
    const text = held.rest + chunk
    const cut = text.lastIndexOf('\n')
    if (cut < 0) {
      // A line that never ends (a `\r` progress bar) is printed at the cap
      // rather than held without bound.
      if (text.length < KEPT_LINE_CAP) held.rest = text
      else {
        held.rest = ''
        taskWrite(fenced(formatKeptLines(node, text, colors)))
      }
      return
    }
    held.rest = text.slice(cut + 1)
    taskWrite(fenced(formatKeptLines(node, text.slice(0, cut), colors)))
  }
  const flushKept = (): void => {
    for (const held of keptLines.values()) {
      if (held.rest.length > 0) taskWrite(fenced(formatKeptLines(held.node, held.rest, colors)))
      held.rest = ''
    }
  }
  const printsKept = (tail: { outcome?: TaskOutcome }): boolean =>
    flushedPersistent && tail.outcome !== undefined && view.mode !== 'errors-only'
  // A server writing before this run started its task is one an earlier run
  // left running (`vx watch` keeps its dev server): it streams as a kept
  // one, live above the rows. Buffered as a task yet to run, it was never shown.
  const heldOver = (node: TaskNode): boolean =>
    node.config.exec?.persistent !== undefined && view.mode !== 'errors-only'

  // A forced refresh the region has not been built for yet: the build
  // takes the forecast pass the event asked for.
  let forcePending = false
  // The region is built when the writer draws it (`setRegion`'s function
  // form), from the state as it is then: the events a forced-redraw floor
  // coalesces build nothing.
  const refresh = (forced: boolean): void => {
    if (statusDead) return
    const first = forecastFn === undefined && graphForecast !== undefined && !tail && !stopping
    forcePending ||= forced || first
    writer.setRegion(buildRegion, { force: forced || first })
  }
  const buildRegion = (): readonly string[] => {
    let force = forcePending
    forcePending = false
    const now = Date.now()
    // A task its executor still holds has not begun: its clock starts at
    // the first frame a machine runs it.
    const where = runContext?.whereRunning
    if (where !== undefined)
      for (const x of [...slots, ...slotQueue]) {
        if (x === null) continue
        x.waiting = where(x.id) === null
        if (x.waiting) x.startedMs = now
      }
    // The rows' blocked counts and planned tasks from the first frame: the
    // graph knows, without history.
    if (forecastFn === undefined && graphForecast !== undefined && !tail && !stopping) {
      forecastFn = graphForecast()
      graphForecast = undefined
      force = true
    }
    // Twice a second at most: one pass over the unfinished graph.
    if (forecastFn !== undefined && !tail && !stopping && (force || now - etaAtMs >= 500)) {
      etaAtMs = now
      const running = new Map<string, number>()
      for (const s of slots) if (s !== null) running.set(s.id, s.startedMs)
      for (const s of slotQueue) running.set(s.id, s.startedMs)
      const f = forecastFn(finished, running, now)
      deadlineMs =
        f.etaMs === undefined
          ? undefined
          : f.etaMs > 0
            ? now + f.etaMs
            : Math.min(deadlineMs ?? now, now)
      critical = f.critical
      blockedCount = f.waiting
      expected = f.expected
      blocked = f.blocked
      blockedBy = f.blockedBy
    }
    const etaMs = deadlineMs === undefined ? undefined : deadlineMs - now
    if (signals.progress && total > 0) {
      const elapsed = now - startedAtMs
      const pct = Math.floor(
        etaMs !== undefined && etaMs > 0
          ? (elapsed / (elapsed + etaMs)) * 100
          : (done / total) * 100,
      )
      // Never backwards: a forecast that gives up falls back to the count.
      if (pct > progressShown || failed > 0 !== progressRed) {
        progressShown = Math.max(pct, progressShown)
        progressRed = failed > 0
        out.write(progressEscape(progressShown, progressRed))
      }
    }
    let running = 0
    let scheduled = 0
    // Stopping, the rows say `aborting`: nothing is running or scheduled.
    if (!tail && !stopping)
      for (const x of [...slots, ...slotQueue]) {
        if (x === null) continue
        if (x.waiting === true) scheduled++
        else running++
      }
    if (critical !== undefined && running > 0) onPath.add(critical)
    // The live summary IS the final summary's section, built from the
    // same formatter so the region visually becomes the printout.
    const summaryLines =
      opts.footer === false || !started
        ? []
        : formatSummarySection(
            {
              failed,
              successful: succeeded + upToDate + restoredLocal + restoredRemote,
              skipped: skippedCount,
              total: total - stopped - notRun,
              ...(stopped > 0 ? { aborted: stopped } : {}),
              ...(notRun > 0 ? { notRun } : {}),
              upToDate,
              restoredLocal,
              restoredRemote,
              saved,
              notSaved,
              miss: succeeded + failed - noCache,
              noCache,
              left: total - done - stopped - notRun,
              ...(running > 0 ? { running } : {}),
              ...(scheduled > 0 ? { scheduled } : {}),
              ...(blockedCount > 0 && !tail && !stopping ? { blocked: blockedCount } : {}),
              ...(etaMs !== undefined && !tail && !stopping
                ? etaMs > 0
                  ? { etaMs }
                  : { overMs: -etaMs }
                : {}),
              buckets,
              spread:
                spreadCount > 0
                  ? { maxMs: spreadMax, minMs: spreadMin, sumMs: spreadSum, count: spreadCount }
                  : null,
            },
            Date.now() - startedAtMs,
            colors,
            runContext,
          )
    const shownSteps: WorkerSlot[] = []
    for (const [id, startedMs] of steps)
      if (now - startedMs >= STEP_SHOWN_MS) shownSteps.push({ id, startedMs })
    return formatStatusRegion(
      {
        pinnedPersistent: pinnedPersistent
          .filter((o) => o.serverExit === undefined)
          .map((o) => o.node.id),
        // Every running task has a row: one beyond the slots follows them.
        slots: [...slots, ...slotQueue],
        size: slots.length,
        ...(blocked !== undefined && !stopping ? { next: blocked } : {}),
        ...(blockedBy !== undefined && !stopping ? { blockedBy } : {}),
        ...(stopping ? { stopping } : {}),
        ...(shownSteps.length > 0 ? { steps: shownSteps } : {}),
        nowMs: Date.now(),
        summaryLines,
        ...(runContext?.whereRunning !== undefined ? { where: runContext.whereRunning } : {}),
        ...(expected !== undefined ? { expected } : {}),
        ...(critical !== undefined ? { critical } : {}),
      },
      colors,
    )
  }
  const tick = (): void => {
    if (!writer.enabled || statusDead || ticker !== null) return
    // Keeps the per-worker elapsed time ticking between task events
    // (the time IS the motion — there's no spinner). The writer
    // throttles unforced redraws, and unref means a stray ticker
    // can never hold the process open.
    ticker = setInterval(() => {
      refresh(false)
    }, 100)
    ticker.unref?.()
  }
  const killStatus = (): void => {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
    if (forecastTimer !== null) {
      clearTimeout(forecastTimer)
      forecastTimer = null
    }
    if (progressShown >= 0) {
      progressShown = -1
      out.write(PROGRESS_CLEAR)
    }
    if (statusDead) return
    statusDead = true
    writer.clearStatus()
  }

  // The task log opens with one blank line before its first row, on a
  // terminal and off one (2026-10-14). A note vx prints before it is
  // no task row (`status`). Without a footer, the caller frames the log
  // (`vx watch` opens each cycle with its own line).
  let logOpened = opts.footer === false
  // The log ends on a blank line (a block's own): a blank status line
  // after it (the footer's) would make two; one blank line apart is the rule.
  let endsBlank = false
  // A live-streamed task's partial line ends before anything of vx's own:
  // a row or a block written after it (a step that ends while the task
  // streams, another task's failure, a kept server's line) was glued to
  // it, `building...      time status  cache    task`.
  const endStreamLine = (): void => {
    if (!streamMidLine) return
    streamMidLine = false
    logWrite('\n')
  }
  const taskWrite = (chunk: string): void => {
    endStreamLine()
    logWrite(chunk)
  }
  const streamWrite = (chunk: string): void => {
    streamedSinceBlock = true
    if (chunk.length > 0) streamMidLine = !chunk.endsWith('\n')
    logWrite(chunk)
  }
  const logWrite = (chunk: string): void => {
    if (chunk.length > 0) endsBlank = chunk.endsWith('\n\n')
    if (!logOpened && chunk.length > 0) {
      logOpened = true
      writer.write(`\n${chunk}`)
      return
    }
    writer.write(chunk)
  }
  const emitLine = (line: string): void => {
    taskWrite(`${line}\n`)
    lineEmitted = true
  }
  // The list's header, once over its first row, where the live region
  // heads its own rows the same way (2026-10-21).
  let headed = !writer.enabled
  const emitRow = (line: string): void => {
    if (!headed) {
      headed = true
      emitLine(formatListHeader(runContext?.whereRunning !== undefined, colors))
    }
    emitLine(line)
  }
  // formatTaskBlock returns '' for group tasks (no exec) — skip the
  // write so a stray newline doesn't sneak into the output.
  const emitBlock = (block: string): void => {
    if (block.length === 0) return
    endStreamLine()
    const lead = lineEmitted || streamedSinceBlock ? '\n' : ''
    taskWrite(`${lead}${block}\n`)
    lineEmitted = false
    streamedSinceBlock = false
  }
  // Live-frame close lines end a frame the same way emitBlock does:
  // with a trailing blank line, resetting the separator state.
  const emitFrameClose = (line: string): void => {
    taskWrite(`${line}\n\n`)
    lineEmitted = false
    streamedSinceBlock = false
  }

  // Focused mode streams requested nodes' output live and raw —
  // `vx run test` should feel like running the command directly.
  // Cache-hit replay arrives through the same taskStdout path, so it
  // streams identically. Only with a SINGLE requested task, though:
  // concurrent live frames interleave (see requestedCount above), so
  // multiple requested tasks buffer and emit atomic blocks instead.
  // A requested task — or a non-group dep surfaced from a requested
  // group (see markSurfacedDeps) — is a "primary" node the focused
  // view shows. Groups never stream (no output of their own).
  const isPrimary = (node: TaskNode): boolean => node.requested || node.surfaced === true
  // A task handed the terminal writes to it directly, so the status region
  // goes for good (it would repaint over a prompt) and, in the views that
  // frame executed work, a live frame opens before it and closes after;
  // what vx itself says about it streams inside.
  const holdsTerminal = (node: TaskNode): boolean =>
    opts.tty === true && node.config.exec?.interactive === true
  const framesTerminal = view.mode === 'full' || view.mode === 'focused' || view.mode === 'broad'
  const streamsLive = (node: TaskNode): boolean =>
    (framesTerminal && holdsTerminal(node)) ||
    (view.mode === 'focused' && isPrimary(node) && !isGroupTask(node) && requestedCount <= 1)

  const failureRow = (node: TaskNode, outcome: TaskOutcome): string =>
    formatFailureLine(node.id, outcome.durationMs, colors, cacheWordOf(outcome)) +
    (onPath.has(node.id) ? pathNote(colors) : '') +
    whereNote(outcome, colors) +
    flakyNote(outcome, colors)

  return {
    showsSteps: writer.enabled,
    settle() {
      // The bus delivers one `run:end`, so the CLI's last word reaches here.
      flushKept()
      writer.settle()
    },
    status(line) {
      // A kept server's held partial line is older than this line: held
      // past it, a server's last words printed below its own exit notice.
      flushKept()
      // A live-streamed server keeps writing after its frame closes, so a
      // summary row or "exited with code" can follow its partial line.
      endStreamLine()
      if (line === '' && endsBlank) return
      endsBlank = line === ''
      writer.write(`${line}\n`)
    },
    warn(line) {
      flushKept()
      endStreamLine()
      writer.writeTo(errOut, `${ui.tagged('warn', line, colors)}\n`)
    },
    runStart(info) {
      total = info.total
      requestedCount = info.requestedCount ?? requestedCount
      runContext = info.context
      startedAtMs = Date.now()
      started = true
      slots = Array.from({ length: Math.max(1, info.concurrency ?? 10) }, () => null)
      tick()
      refresh(true)
    },
    stepStart(id) {
      steps.set(id, Date.now())
      // Drawn by the ticker once it passes STEP_SHOWN_MS; a quicker one never is.
      tick()
    },
    stepEnd(id, { durationMs, ok }) {
      steps.delete(id)
      if (durationMs < STEP_SHOWN_MS) return
      // `hash-only` is one line per task: only a step that failed adds one.
      if (
        ok
          ? view.mode !== 'none' && view.mode !== 'errors-only' && view.mode !== 'hash-only'
          : view.mode !== 'none'
      )
        emitRow(formatStepLine(id, durationMs, ok, colors))
      refresh(true)
    },
    runStop() {
      if (stopping) return
      stopping = true
      blocked = undefined
      blockedBy = undefined
      refresh(true)
    },
    runDone() {
      tail = false
      killStatus()
    },
    taskStart(node) {
      if (isGroupTask(node)) return
      if (holdsTerminal(node)) {
        killStatus()
        // What is coalesced lands before the task writes past it.
        writer.settle()
      }
      // Focused flow: a requested node streams raw, and the region stays
      // under its output (the writer erases and redraws it around each
      // write): taken down, the summary and the run's id were gone until
      // the task ended.
      if (streamsLive(node)) {
        // Open the live frame: full task info even when the command
        // streams nothing (or the hit replays nothing).
        emitLine(formatFrameOpen(node, colors, forwardArgs))
      } else if (node.config.exec?.persistent !== undefined && !persistentTails.has(node.id)) {
        // Bound a persistent task's output from its FIRST chunk. Waiting for
        // its outcome would leave a never-ready one uncapped forever.
        persistentTails.set(node.id, { node, out: createTail(), err: createTail() })
      }
      // The rows are the status region's; with none, nothing reads them.
      if (statusDead) return
      const slot: WorkerSlot = { id: node.id, startedMs: Date.now() }
      const free = slots.indexOf(null)
      if (free >= 0) slots[free] = slot
      else slotQueue.push(slot)
      refresh(true)
    },
    holdStatus: () => writer.hold(),
    forecast(graph, load) {
      if (statusDead || forecastTimer !== null) return
      graphForecast = graph
      forecastTimer = setTimeout(() => {
        forecastTimer = null
        if (statusDead) return
        load().then(
          (f) => {
            forecastFn = f
            if (!statusDead) refresh(true)
          },
          // History is observability: an unreadable one forecasts nothing.
          () => {},
        )
      }, FORECAST_AFTER_MS)
      forecastTimer.unref?.()
    },
    runEnd() {
      // A long run says it ended where the user is not looking. Once:
      // the status is dead after the first runEnd.
      if (signals.notify && !statusDead && !tail && Date.now() - startedAtMs >= NOTIFY_AFTER_MS) {
        out.write(
          notifyEscape(
            failed > 0
              ? `vx: ${failed} of ${total} task${total === 1 ? '' : 's'} failed`
              : `vx: ${total} task${total === 1 ? '' : 's'} done`,
          ),
        )
      }
      if (!tail && !statusDead) {
        tail = true
        slots = []
        blocked = undefined
        blockedBy = undefined
        slotQueue.length = 0
        refresh(true)
      } else if (!tail) killStatus()
      // Persistent tails first: they are context for whatever ran against
      // the server, so they read above the failures they explain. `none`
      // prints no per-task output and `errors-only` only failed tasks: a
      // server that died on its own before the run stopped it is failed by
      // now (run.ts sets its outcome in place), and under `errors-only` its
      // tail was dropped with the healthy ones', so the crash read only as a
      // count (WD-25). The rest is still captured and bounded. Guarded
      // like the failures below: run() calls runEnd twice on the success
      // path (once before the summary, once in its finally), and though the
      // bus delivers `run:end` once (`busLogger`), a renderer an embedder
      // drives directly may hear both.
      if (flushedPersistent) flushKept()
      if (!flushedPersistent) {
        flushedPersistent = true
        if (view.mode !== 'none') {
          for (const t of persistentTails.values()) {
            // No outcome means the task never completed — it is still
            // pre-ready, so there is no "since ready" window to render and
            // its buffered output belongs to the frame it never got.
            if (t.outcome === undefined) continue
            if (view.mode === 'errors-only' && t.outcome.status !== 'failed') continue
            emitBlock(
              fenced(
                formatPersistentTailBlock(
                  t.node,
                  t.outcome,
                  { stdout: tailText(t.out), stderr: tailText(t.err) },
                  { stdout: t.out.dropped, stderr: t.err.dropped },
                  colors,
                  forwardArgs,
                ),
              ),
            )
          }
        }
        for (const t of persistentTails.values()) {
          resetTail(t.out)
          resetTail(t.err)
        }
      }
      // Failures end the log: every deferred frame replays here, right
      // above the summary — the ◼ rows marked them in the stream,
      // the full diagnostics read last where eyes land.
      // Guarded for repeat runEnd calls.
      if (!flushedFailures && deferredFailures.length > 0) {
        flushedFailures = true
        for (const block of deferredFailures) emitBlock(fenced(block))
      }
      // The summary and the CLI's own lines follow on the stream directly:
      // nothing may still be held, and nothing after this is.
      writer.settle()
    },
    taskStdout(node, chunk) {
      if (discardsOutput) return
      if (streamsLive(node)) {
        streamWrite(chunk)
        return
      }
      const tail = persistentTails.get(node.id)
      if (tail !== undefined) {
        if (printsKept(tail)) streamKept(node, chunk)
        else appendTail(tail.out, chunk)
        return
      }
      if (heldOver(node)) return streamKept(node, chunk)
      pushChunk(node.id, chunk, false)
    },
    taskStderr(node, chunk) {
      if (discardsOutput) return
      if (streamsLive(node)) {
        streamWrite(chunk)
        return
      }
      const tail = persistentTails.get(node.id)
      if (tail !== undefined) {
        if (printsKept(tail)) streamKept(node, chunk)
        else appendTail(tail.err, chunk)
        return
      }
      if (heldOver(node)) return streamKept(node, chunk)
      pushChunk(node.id, chunk, true)
    },
    taskComplete(node, outcome) {
      if (!statusDead) finished.add(node.id)
      // A persistent task buffered into its bounded tail rather than the
      // per-task buffers (see taskStart), so its frame is drained from
      // there — carrying how much the cap dropped, since a truncated log
      // that reads as complete is worse than one that says what it lost.
      const preReady = persistentTails.get(node.id)
      // In the order the task wrote it; a bounded tail kept its streams
      // apart, so its stdout reads first.
      const output: OutputChunk[] = preReady
        ? [
            { text: tailText(preReady.out), err: false },
            { text: tailText(preReady.err), err: true },
          ]
        : takeChunks(node.id)
      const dropped =
        preReady && (preReady.out.dropped > 0 || preReady.err.dropped > 0)
          ? { droppedStdout: preReady.out.dropped, droppedStderr: preReady.err.dropped }
          : {}
      // The pre-ready window closed either way: a failed task is over, and
      // a ready one starts a fresh post-ready tail below.
      persistentTails.delete(node.id)
      // An aborted task (killed by a shutdown signal, or reached by the stop
      // before it ran) frees its worker slot and counts as the footer will
      // count it: `aborted` or `not run`, beside no total.
      if (outcome.status === 'aborted') {
        if (!isGroupTask(node)) {
          if (neverStarted(outcome)) notRun++
          else stopped++
        }
        const si = slots.findIndex((s) => s !== null && s.id === node.id)
        if (si >= 0) slots[si] = slotQueue.shift() ?? null
        else {
          const qi = slotQueue.findIndex((s) => s.id === node.id)
          if (qi >= 0) slotQueue.splice(qi, 1)
        }
        refresh(true)
        if (isGroupTask(node)) return
        // What it printed while it stopped (a trap's cleanup) still reaches
        // the terminal where a frame would have: a task that traps Ctrl-C
        // and exits 0 is aborted since item 962, and its frame was dropped
        // with the count. A task that never started opened no frame.
        const framed =
          !neverStarted(outcome) &&
          (view.mode === 'full' ||
            (view.mode === 'focused' && isPrimary(node)) ||
            (framesTerminal && holdsTerminal(node)))
        if (framed && streamsLive(node)) {
          emitFrameClose(formatFrameClose(node, outcome, colors))
          return
        }
        if (framed && output.some((c) => c.text.length > 0)) {
          emitBlock(
            formatTaskBlock(
              node,
              outcome,
              { output, ...dropped },
              colors,
              true,
              forwardArgs,
              links,
            ),
          )
          return
        }
        // Otherwise a row in the task list, in every view that lists a
        // failure: the run exits red, and the row names why.
        if (view.mode !== 'none' && view.mode !== 'hash-only') {
          emitRow(formatTaskAbortedLine(node, outcome, colors))
        }
        return
      }
      // Group tasks (no exec) do no work — no surface prints them.
      if (!isGroupTask(node)) {
        done++
        if (outcome.status === 'failed') {
          failed++
          if (ranNoCache(outcome)) noCache++
        } else if (node.config.exec?.persistent !== undefined && outcome.status === 'success') {
          // A persistent task's outcome arrives at READY; the child
          // keeps running until the orchestrator SIGTERMs it at run
          // end — pin it so its liveness stays visible.
          pinnedPersistent.push(outcome)
          // …and capture what it writes from here on. A live-streaming
          // node already owns the terminal, so buffering it would emit
          // its output twice.
          if (!streamsLive(node)) {
            persistentTails.set(node.id, { node, outcome, out: createTail(), err: createTail() })
          }
        }
        // Free the task's slot; the longest-waiting queued task
        // (if any) takes it over, keeping lowest-index-first reuse.
        if (!statusDead) {
          const si = slots.findIndex((s) => s !== null && s.id === node.id)
          if (si >= 0) slots[si] = slotQueue.shift() ?? null
          else {
            const qi = slotQueue.findIndex((s) => s.id === node.id)
            if (qi >= 0) slotQueue.splice(qi, 1)
          }
        }
        const bucket = cacheBucketOf(outcome)
        if (bucket !== undefined) {
          const entry = { task: node.id, bucket }
          if (outcome.hash !== undefined) buckets.set(outcome.hash, entry)
          buckets.set(node.id, entry)
        }
        switch (outcome.status) {
          case 'success':
            succeeded++
            if (ranNoCache(outcome)) noCache++
            if (outcome.saved === true) saved++
            else if (ranUnsaved(outcome)) notSaved++
            break
          case 'cache-hit':
            if (outcome.restored === false) upToDate++
            else restoredLocal++
            break
          case 'cache-hit-remote':
            if (outcome.restored === false) upToDate++
            else restoredRemote++
            break
          case 'skipped':
            skippedCount++
            break
        }
        if (outcome.status === 'success' || outcome.status === 'failed') {
          spreadMax = Math.max(spreadMax, outcome.durationMs)
          spreadMin = Math.min(spreadMin, outcome.durationMs)
          spreadSum += outcome.durationMs
          spreadCount++
        }
        refresh(true)
      }
      if (isGroupTask(node)) return
      if (holdsTerminal(node) && streamsLive(node) && outcome.status !== 'skipped') {
        emitFrameClose(formatFrameClose(node, outcome, colors))
        return
      }
      const isHit = isCacheHit(outcome.status)
      switch (view.mode) {
        case 'none':
          return
        case 'hash-only': {
          // The word carries the outcome (skips/failures included); the
          // key is what this mode exists to show — absent for a task
          // that never computed one (skipped, uncacheable).
          emitLine(formatTaskHashLine(node, outcome, colors))
          return
        }
        case 'errors-only':
          if (outcome.status === 'skipped') {
            emitRow(formatTaskSkippedLine(node, colors, outcome))
            return
          }
          if (outcome.status !== 'failed') return
          emitRow(failureRow(node, outcome))
          deferredFailures.push(
            formatTaskBlock(
              node,
              outcome,
              { output, ...dropped },
              colors,
              false,
              forwardArgs,
              links,
            ),
          )
          return
        case 'broad':
          // News only: executed work and skips get a one-liner, failures
          // get the full frame. Hits (including up-to-date) are silent —
          // their replay buffers are deliberately dropped; the counts
          // surface in the end-of-run summary.
          if (outcome.status === 'failed') {
            // ◼ row now; the full frame replays at runEnd.
            emitRow(failureRow(node, outcome))
            deferredFailures.push(
              formatTaskBlock(
                node,
                outcome,
                { output, ...dropped },
                colors,
                false,
                forwardArgs,
                links,
              ),
            )
          } else if (outcome.status === 'success') {
            emitRow(formatTaskExecutedLine(node, outcome, colors, onPath.has(node.id)))
          } else if (outcome.status === 'skipped') {
            emitRow(formatTaskSkippedLine(node, colors, outcome))
          }
          return
        case 'focused':
          if (isPrimary(node)) {
            // Skipped tasks never started (blocked upstream, or the run
            // stopped), so no frame-open fired — and a skip has no output,
            // so a one-liner carries everything a frame would.
            if (outcome.status === 'skipped') {
              emitRow(formatTaskSkippedLine(node, colors, outcome))
              return
            }
            if (streamsLive(node)) {
              // Single requested task: output (exec or hit replay)
              // streamed live between the frame-open (taskStart) and
              // this close — full task info for every outcome, cached
              // and up-to-date included (owner: "always full frame
              // for a single task").
              emitFrameClose(formatFrameClose(node, outcome, colors))
              return
            }
            // Multiple requested tasks: no live frame was opened (it
            // would interleave with siblings). Failures still defer
            // to runEnd like everywhere else; everything else emits
            // ONE atomic block from the buffered output.
            if (outcome.status === 'failed') {
              emitRow(failureRow(node, outcome))
              deferredFailures.push(
                formatTaskBlock(
                  node,
                  outcome,
                  { output, ...dropped },
                  colors,
                  false,
                  forwardArgs,
                  links,
                ),
              )
              return
            }
            // forceCommand: a requested task's frame shows `$ cmd`
            // whether it ran or was cached — same frame every run.
            emitBlock(
              formatTaskBlock(
                node,
                outcome,
                { output, ...dropped },
                colors,
                true,
                forwardArgs,
                links,
              ),
            )
            return
          }
          // Dependency-pulled nodes: silent on success; a skip gets its
          // row, failures the ◼ row now and their frame replayed at runEnd.
          if (outcome.status === 'skipped') {
            emitRow(formatTaskSkippedLine(node, colors, outcome))
          } else if (outcome.status === 'failed') {
            emitRow(failureRow(node, outcome))
            deferredFailures.push(
              formatTaskBlock(
                node,
                outcome,
                { output, ...dropped },
                colors,
                false,
                forwardArgs,
                links,
              ),
            )
          }
          return
        case 'full': {
          // Cache hits with nothing to replay compress to ONE line —
          // every task stays visible, but at 2000+ tasks the two-line
          // frames would drown what actually happened. Hits WITH
          // replayed stdout keep their frame (the output is the
          // point); misses/failures are always framed. One-liners
          // stay outside ::group:: — there's nothing to collapse.
          if (isHit && output.every((c) => c.text.trim().length === 0)) {
            emitRow(formatTaskHitLine(node, outcome, colors, onPath.has(node.id)))
            return
          }
          if (outcome.status === 'skipped') {
            emitRow(formatTaskSkippedLine(node, colors, outcome))
            return
          }
          const block = formatTaskBlock(
            node,
            outcome,
            { output, ...dropped },
            colors,
            false,
            forwardArgs,
            links,
          )
          if (block.length === 0) return
          if (view.gha) {
            // The block is the task's own output — fenced, so a task that
            // prints `::endgroup::` can't close vx's group early and an
            // `::error` line in its output can't become a real annotation.
            const body = ghaFence(block, ghaToken)
            // Failed tasks stay pre-expanded in the Actions viewer:
            // an ::error annotation instead of a collapsed group.
            if (outcome.status === 'failed') {
              // The message is ours (a literal, an integer and a signal
              // name); only the title carries user input.
              emitBlock(
                `::error title=${ghaProperty(node.id)}::${failedLabel(outcome.exitCode, outcome.timedOut, outcome.sandboxViolations, outcome.notReady, outcome.inputMoved)}\n${body}`,
              )
            } else {
              emitBlock(
                `::group::${ghaData(
                  `${node.id} (${outcomeWord(outcome)} ${formatElapsed(outcome.durationMs)})`,
                )}\n${body}::endgroup::\n`,
              )
            }
            return
          }
          emitBlock(block)
          return
        }
      }
    },
  }
}
