import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { settingEnv } from '../settings.js'
import {
  formatFrameClose,
  formatFrameOpen,
  formatKeptLines,
  formatPersistentTailBlock,
  formatListHeader,
  usualCell,
  formatTaskAbortedLine,
  executedCells,
  formatTaskExecutedLine,
  flakyNote,
  formatTaskHashLine,
  formatTaskHitLine,
  formatTaskSkippedLine,
  type OutputChunk,
  type OutputSource,
  type TaskBlockBody,
  taskBlockPieces,
} from './framed-output.js'
import { once, paced, stepping } from './paced.js'
import { DeferredFrames, OutputSpool, TaskOutput } from './task-output.js'
import {
  formatFailureLine,
  formatStatusRegion,
  formatStepLine,
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
import { isGroupTask, isKeyFailed } from '../graph/index.js'
import {
  appendTail,
  createTail,
  formatElapsed,
  resetTail,
  secretMask,
  tailText,
  type Tail,
  ciProvider,
  noteWrite,
  relPosix,
} from '../util/index.js'
import * as ui from '../ui/index.js'
import {
  createOutputWriter,
  detectColors,
  hasEscape,
  leavesStyle,
  notifyEscape,
  PROGRESS_CLEAR,
  progressEscape,
  STYLE_END,
  terminalLinks,
  terminalSignals,
  type ColorSupport,
  type StatusStream,
} from '../ui/index.js'
import { isCacheHit } from '../graph/index.js'
import { runTime } from '../exec/index.js'
import { outcomeLabel, outcomeWord, ranNoCache } from './events.js'
import type { BlockedTask, Forecast } from './forecast.js'

export interface Logger {
  /** Header / footer / status text. Written verbatim, one trailing \n added. */
  status(line: string): void
  /**
   * A warning: something worked, but look at it. The default logger writes it
   * to stderr, so stdout carries only rows and footer. A logger without it gets
   * warnings through `status`.
   */
  warn?(line: string): void
  /** Streamed stdout chunk for a task. Kept until `taskComplete`. */
  taskStdout(node: TaskNode, chunk: string): void
  /** Streamed stderr chunk for a task. Kept until `taskComplete`. */
  taskStderr(node: TaskNode, chunk: string): void
  /**
   * Flush a task's kept output as one framed block. Called once
   * per task on completion (success, failure, cache hit, or skip).
   */
  taskComplete(node: TaskNode, outcome: TaskOutcome): void
  /**
   * Optional lifecycle hooks; the default logger drives its status line with
   * them.
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
   * Hand over any coalesced output and write straight through from now on.
   * `runEnd` does it; the run's `finally` again, for a throw.
   */
  settle(): void
  /**
   * Whether vx's own steps show: only beside a live region. A log stays free of
   * rows whose presence is a timing. False: run() never times a step.
   */
  readonly showsSteps: boolean
  /**
   * Hand the live region the forecast, once at run start: `graph` is built when
   * a worker row is first free; `load` adds history's timings only if the
   * region is still live a second in.
   */
  forecast(graph: () => Forecast, load: () => Promise<Forecast>): void
  /** Draw no live region until the returned release: a prompt waits on the terminal. */
  holdStatus(): () => void
  /** `vx watch` kept this server up from the cycle before: its frame closes `still running`. */
  serverKept(id: string): void
  /** vx stopped this ready server at the run's end: its since-ready block closes `stopped`. */
  serverStopped(id: string): void
  /** Where task output waits for its frame: the run's cache directory, once known. */
  spoolIn(dir: string): void
  /** Resolves once everything written is with its stream: a slow reader paces frames. */
  drained(): Promise<void>
}

/**
 * The default logger's per-task output policy, from `--output-logs`, else a
 * CI (`ciProvider`: any CI variable on), else the CLI's flow: full: frames for executed work, one-liners
 * for quiet hits; CI's and the programmatic default. errors-only: only failed
 * tasks print. none: no per-task output. hash-only: one line per task (outcome,
 * id, key), Turbo's parity; the summary still renders. focused: requested nodes
 * stream raw, live; dependencies are silent unless they fail. broad: a
 * `success` line per executed task, frames for failures, silent hits.
 *
 * `gha` (GitHub Actions): task output is fenced from workflow commands; in full
 * mode each block is a collapsible group, except failures, which stay open with
 * an `::error` annotation, as each deferred failure frame has in the list views.
 *
 * `ci`: suppresses the status line even on a TTY.
 */
export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean
  ci?: boolean
}

// ── GitHub Actions workflow-command escaping ──────────────────────── The
// runner parses `::`-prefixed lines, so anything interpolated into one must be
// encoded. Both halves happen innocently: a task name may hold newlines, and a
// task may print command-shaped text.
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions

/** Message text. `%` first, or we would re-escape our own escapes. */
function ghaData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * A property value also reserves `:` and `,`, or an id containing `::`
 * truncates the title.
 */
function ghaProperty(value: string): string {
  return ghaData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

/**
 * Fence untrusted text from workflow commands. The token must be unguessable by
 * the fenced text, so it is a per-run UUID.
 */
function ghaFence(body: string, token: string): string {
  const [open, close] = ghaFenceEnds(token)
  return `${open}${body}${close}`
}

/** The lines `ghaFence` puts before and after the text. */
function ghaFenceEnds(token: string): [open: string, close: string] {
  return [`::stop-commands::${token}\n`, `::${token}::\n`]
}

const cacheWordOf = (o: TaskOutcome): 'miss' | 'no-cache' | 'kept' | '' =>
  o.restoreFailed === true || isKeyFailed(o)
    ? ''
    : o.cache?.kept === true
      ? 'kept'
      : ranNoCache(o)
        ? 'no-cache'
        : 'miss'

export function resolveOutputView(
  options: {
    outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
    flow?: 'focused' | 'broad'
  },
  env: Record<string, string | undefined> = process.env,
): OutputView {
  // One rule for "on CI" (`ciProvider`): a Jenkins job, which sets no `CI`,
  // got the laptop's flow while the rest of vx called it CI.
  const provider = ciProvider(env)
  const ci = provider !== null
  const gha = provider === 'github'
  const mk = (mode: OutputView['mode']): OutputView => ({
    mode,
    ...(gha ? { gha: true } : {}),
    ...(ci ? { ci: true } : {}),
  })
  // `run.outputLogs`: chosen before the workspace loads, so flag, then variable.
  const outputLogs =
    options.outputLogs ?? (settingEnv('run.outputLogs', env) as OutputView['mode'] | undefined)
  if (outputLogs !== undefined) return mk(outputLogs)
  // A CI log is read for what broke (M, 2026-11-22).
  return mk(ci ? 'errors-only' : (options.flow ?? 'full'))
}

/** A run shorter than this never reads history for a forecast. */
const FORECAST_AFTER_MS = 1000
/** A run shorter than this ends without a desktop notification. */
const NOTIFY_AFTER_MS = 10_000
// A step of vx's own quicker than this shows nowhere.
const STEP_SHOWN_MS = 150

/** A frame this long is written in pieces, never copied into one string. */
const PIECEWISE_CHARS = 1024 * 1024

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
  // stderr decides its own colour: `vx run 2> warn.log` on a terminal wrote
  // escapes into the file. A given stream is the caller's and takes `colors`.
  const errColors = opts.err === undefined && colors.enabled ? detectColors(process.stderr) : colors
  // Each task's output until it ends, in order, both streams: in one file the
  // tasks share (`OutputSpool`), never memory.
  const spool = new OutputSpool()
  const outputs = new Map<string, TaskOutput>()
  const keptServers = new Set<string>()
  const stoppedServers = new Set<string>()
  // Blocks are blank-line-delimited on both sides, so raw frame content never
  // touches a one-liner. A block leaves its trailing blank; a one-liner or
  // streamed output since needs a leading one.
  let lineEmitted = false
  let streamedSinceBlock = false
  // True while the live stream sits mid-line (chunk without trailing
  // newline) — the frame close must not glue onto partial output.
  let streamMidLine = false
  const pushChunk = (id: string, text: string, err: boolean): void => {
    let out = outputs.get(id)
    if (out === undefined) outputs.set(id, (out = new TaskOutput(spool)))
    out.push(text, err)
  }
  const takeOutput = (id: string): TaskOutput => {
    const out = outputs.get(id)
    if (out === undefined) return new TaskOutput(spool)
    outputs.delete(id)
    return out
  }

  // `none` and `hash-only` promise never to print task output, so chunks are
  // dropped on arrival: not even written to a file. The other modes print the
  // whole of it (errors-only's failure log is the point), never truncated.
  const discardsOutput = view.mode === 'none' || view.mode === 'hash-only'

  // One per run, and only in GHA mode: the fence token must be something the
  // fenced task output cannot print.
  const ghaToken = view.gha === true ? crypto.randomUUID() : ''
  // A task's own text, fenced on GitHub Actions: the frames `errors-only`
  // and `broad` defer and a server's tail printed a task's `::error::` raw.
  const fenced = (block: string): string =>
    view.gha === true && block.length > 0 ? ghaFence(block, ghaToken) : block

  // All stdout goes through the writer so the status line never interleaves
  // with content. Passthrough off a TTY and in CI. Every write is paced
  // (`paced.ts`): a frame read from its file waits for a slow reader.
  const pace = paced(
    createOutputWriter(out, {
      enabled: view.ci !== true,
      ...(opts.forceFloorMs !== undefined ? { forceFloorMs: opts.forceFloorMs } : {}),
      ...(opts.coalesce === true ? { coalesce: true } : {}),
    }),
  )
  const { writer, direct: raw } = pace

  // Status-display state, driven by the optional lifecycle hooks.
  let total = 0
  // Live open/close framing needs one requested task owning the terminal;
  // several would interleave, so each is buffered and emitted as one block.
  // Undefined, 0 or 1 keeps the single live view.
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
  // Each task's usual time once history is read: the results' `±usual`.
  let blocked: readonly BlockedTask[] | undefined
  let blockedBy: ReadonlyMap<string, number> | undefined
  let etaAtMs = 0
  const signals = writer.enabled
    ? terminalSignals(opts.env ?? process.env)
    : { progress: false, notify: false }
  const links = writer.enabled && terminalLinks(opts.env ?? process.env)
  let progressShown = -1
  let progressRed = false

  // Every interactive view renders the fixed-height running list: one row per
  // worker, sized at runStart, so its height never changes; a task keeps its
  // slot for life. Excess tasks queue below the slots.
  let slots: (WorkerSlot | null)[] = []
  const slotQueue: WorkerSlot[] = []
  let succeeded = 0
  // Executed without `cache: true`: never a miss, counted apart.
  let noCache = 0
  let upToDate = 0
  let restoredLocal = 0
  let restoredRemote = 0
  // Hits whose restore failed: failed, and in no cache count.
  let restoreFailed = 0
  // A task with no key asked no cache: not a miss.
  let keyFailed = 0
  let saved = 0
  let notSaved = 0
  let skippedCount = 0
  // Each finished task's cache bucket by its key, with a remote: its traffic moves it.
  const buckets = new Map<string, TaskBucket>()
  // The graph is done and vx's own closing steps run: the region stays, footer
  // and step rows, until the footer replaces it.
  let tail = false
  // The run was stopped: the region stays, its running rows say `aborting`, and
  // nothing is forecast or held.
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
  // The pinned zone above the worker rows: persistent tasks pin at ready and
  // stay until runEnd. A failure is not pinned: it is a permanent failed row at
  // once, its frame deferred to runEnd. 'full'/CI keeps frames inline.
  // `note`: a failure's `::error` annotation on GitHub Actions, as `full`
  // writes one: CI's default view wrote none, and a failed check named no task.
  // Each frame is rendered as its task ends and waits in a file.
  const deferredFailures = new DeferredFrames(spool)
  // Each ready server's outcome: one whose child has exited (`serverExit`) is no longer pinned.
  const pinnedPersistent: TaskOutcome[] = []
  let flushedFailures = false
  // A persistent task writes as long as the run lasts, so its chunks go to a
  // bounded tail for its whole life: registered at `taskStart`, drained at
  // `taskComplete` for the frame, then reset to capture what it writes after
  // ready, flushed at runEnd. Registered at ready, a `readyWhen` that never
  // matched grew the ordinary buffer at ~100 MiB/s. Registration is
  // unconditional (a memory invariant); only the flush is view-gated.
  const persistentTails = new Map<
    string,
    { node: TaskNode; outcome?: TaskOutcome; out: Tail; err: Tail }
  >()
  let flushedPersistent = false
  // After that flush a kept server still writes as long as vx holds it, so a
  // ready server's output streams from then on, a line at a time under its id;
  // the partial line waits for its newline, a status line, a second runEnd or
  // `settle`.
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
  // Under errors-only a kept server's output after the summary waits in its
  // tail: once the server has failed (its death in the keep-alive wait), the
  // tail prints, before the line naming its exit.
  const flushFailedKept = (): void => {
    if (!flushedPersistent || view.mode !== 'errors-only') return
    for (const t of persistentTails.values()) {
      if (t.outcome?.status !== 'failed') continue
      const block = formatPersistentTailBlock(
        t.node,
        t.outcome,
        { stdout: tailText(t.out), stderr: tailText(t.err) },
        { stdout: t.out.dropped, stderr: t.err.dropped },
        colors,
        forwardArgs,
      )
      resetTail(t.out)
      resetTail(t.err)
      if (block !== '') emitBlock(fenced(block))
    }
  }
  const printsKept = (tail: { outcome?: TaskOutcome }): boolean =>
    flushedPersistent && tail.outcome !== undefined && view.mode !== 'errors-only'
  // A server writing before this run started its task was left running by an
  // earlier run (`vx watch`): it streams as a kept one. Buffered, it was never
  // shown.
  const heldOver = (node: TaskNode): boolean =>
    node.config.exec?.persistent !== undefined && view.mode !== 'errors-only'

  // A forced refresh the region has not been built for yet: the build
  // takes the forecast pass the event asked for.
  let forcePending = false
  // The region is built when the writer draws it, from the state then:
  // coalesced events build nothing.
  const refresh = (forced: boolean): void => {
    if (statusDead) return
    const first = forecastFn === undefined && graphForecast !== undefined && !tail && !stopping
    forcePending ||= forced || first
    writer.setRegion(buildRegion, { force: forced || first })
  }
  const buildRegion = (): readonly string[] => {
    let force = forcePending
    forcePending = false
    // Rows, steps and the forecast read the clock a task's duration reads:
    // a Ctrl-Z stops it, so a row does not count the time vx was stopped.
    const now = runTime()
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
      blocked = f.blocked
      blockedBy = f.blockedBy
    }
    const etaMs = deadlineMs === undefined ? undefined : deadlineMs - now
    if (signals.progress && total > 0) {
      const elapsed = Date.now() - startedAtMs
      const pct = Math.floor(
        etaMs !== undefined && etaMs > 0
          ? (elapsed / (elapsed + etaMs)) * 100
          : (done / total) * 100,
      )
      // Never backwards: a forecast that gives up falls back to the count.
      if (pct > progressShown || failed > 0 !== progressRed) {
        progressShown = Math.max(pct, progressShown)
        progressRed = failed > 0
        const escape = progressEscape(progressShown, progressRed)
        // In turn: an escape between two pieces of a paced frame could cut a
        // task's own escape in two.
        pace.put(once(() => noteWrite(out, out.write(escape))))
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
              miss: succeeded + failed - noCache - restoreFailed - keyFailed,
              noCache,
              ...(restoreFailed > 0 ? { restoreFailed } : {}),
              left: total - done - stopped - notRun,
              ...(running > 0 ? { running } : {}),
              ...(scheduled > 0 ? { scheduled } : {}),
              ...(blockedCount > 0 && !tail && !stopping ? { blocked: blockedCount } : {}),
              // No machine runs a task, only scheduled ones (a distributed run
              // with no worker joined): the forecast timed them as begun now.
              ...(etaMs !== undefined && !tail && !stopping && (running > 0 || scheduled === 0)
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
        nowMs: now,
        summaryLines,
        ...(runContext?.whereRunning !== undefined ? { where: runContext.whereRunning } : {}),
        ...(runContext?.usage !== undefined ? { usage: runContext.usage } : {}),
        ...(runContext?.usual !== undefined ? { usual: runContext.usual } : {}),
        ...(critical !== undefined ? { critical } : {}),
      },
      colors,
    )
  }
  const tick = (): void => {
    if (!writer.enabled || statusDead || ticker !== null) return
    // Keeps per-worker elapsed times ticking (the time is the motion; no
    // spinner). The writer throttles redraws; unref'd.
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
      pace.put(once(() => noteWrite(out, out.write(PROGRESS_CLEAR))))
    }
    if (statusDead) return
    statusDead = true
    writer.clearStatus()
  }

  // The log opens with one blank line before its first row. A note before it is
  // no row. Without a footer the caller frames the log.
  let logOpened = opts.footer === false
  // The log ends on a blank line (a block's own): a blank status line
  // after it (the footer's) would make two; one blank line apart is the rule.
  let endsBlank = false
  // A live-streamed task's partial line, and any colour it left on, end before
  // vx's own text, or a row written after was glued to it and took its colour.
  let streamStyled = false
  const endStreamLine = (): void => {
    const end = (streamStyled ? STYLE_END : '') + (streamMidLine ? '\n' : '')
    streamStyled = false
    streamMidLine = false
    if (end.length > 0) logWrite(end)
  }
  const taskWrite = (chunk: string): void => {
    endStreamLine()
    logWrite(chunk)
  }
  const streamWrite = (chunk: string): void => {
    streamedSinceBlock = true
    if (chunk.length > 0) streamMidLine = !chunk.endsWith('\n')
    if (hasEscape(chunk)) streamStyled = leavesStyle(chunk)
    logWrite(chunk)
  }
  const logWrite = (chunk: string): void => {
    if (!inPanel && chunk.length > 0) panelOpen = undefined
    if (chunk.length > 0) endsBlank = chunk.endsWith('\n\n')
    if (!logOpened && chunk.length > 0) {
      logOpened = true
      if (chunk.length < PIECEWISE_CHARS) {
        writer.write(`\n${chunk}`)
        return
      }
      writer.write('\n')
    }
    writer.write(chunk)
  }
  const emitLine = (line: string): void => {
    taskWrite(`${line}\n`)
    lineEmitted = true
  }
  // The open panel: rows of one kind share one box (Tasks on the log's stream,
  // Warnings on stderr); anything else closes it and the next row reopens it.
  // Painted, a box; plain on a terminal, a rule and header; piped, the
  // header once over bare rows: an agent reads a pipe, and `28B  3` with no
  // column names said nothing.
  const panels = colors.enabled || writer.enabled
  let panelOpen: 'Tasks' | 'Warnings' | undefined
  let inPanel = false
  let pipeHeaded = false
  const emitRow = (line: string): void => {
    if (!panels) {
      // A run's rows: a bare logger (an embedder's, a test's) and a watch
      // cycle (no footer, its rows its whole report) print only rows.
      if (!pipeHeaded && runContext !== undefined && opts.footer !== false) {
        pipeHeaded = true
        emitLine(ui.panelTop('Tasks', colors, undefined, undefined, formatListHeader(colors)))
      }
      emitLine(line)
      return
    }
    inPanel = true
    if (panelOpen !== 'Tasks') {
      emitLine(ui.panelTop('Tasks', colors, undefined, undefined, formatListHeader(colors)))
      panelOpen = 'Tasks'
    }
    emitLine(line)
    inPanel = false
  }
  // formatTaskBlock returns '' for groups; skip the write. `head` and `tail`
  // wrap the block, written in pieces: joined, a 100 MB log's frame was copied
  // whole again.
  const emitBlock = (block: string, head = '', tail = ''): void => {
    if (block.length === 0) return
    if (block.length >= PIECEWISE_CHARS) return emitLater(() => [block], head, tail, false)
    endStreamLine()
    const lead = lineEmitted || streamedSinceBlock ? '\n' : ''
    taskWrite(`${lead}${head}${block}${tail}\n`)
    lineEmitted = false
    streamedSinceBlock = false
  }
  // A frame read back from its file when its turn to be written comes, in
  // pieces as the reader takes them: the bytes `emitBlock` writes. The state
  // they leave is set now, so what is printed after lines up as if it had been
  // written at once. `whole`: a short frame, written in one write as it always
  // was. `done` once it is written (its log may go).
  const emitLater = (
    pieces: () => Iterable<string>,
    head: string,
    tail: string,
    whole: boolean,
    done?: () => void,
  ): void => {
    endStreamLine()
    const lead = lineEmitted || streamedSinceBlock ? '\n' : ''
    // The log's first write opens it with a blank line, as `logWrite` does.
    const open = logOpened ? '' : '\n'
    logOpened = true
    if (!inPanel) panelOpen = undefined
    // A frame ends on its own blank line.
    endsBlank = true
    lineEmitted = false
    streamedSinceBlock = false
    // Nothing ahead of it: a short frame goes out now, with no job.
    if (whole && pace.idle) {
      const block = [...pieces()].join('')
      if (block.length < PIECEWISE_CHARS) {
        raw.write(`${open}${lead}${head}${block}${tail}\n`)
        done?.()
        return
      }
      pieces = () => [block]
      whole = false
    }
    pace.put(
      stepping(
        (function* () {
          try {
            if (whole) {
              const block = [...pieces()].join('')
              if (block.length < PIECEWISE_CHARS) {
                raw.write(`${open}${lead}${head}${block}${tail}\n`)
                return
              }
              yield* written([block], `${open}${lead}${head}`, tail)
            } else yield* written(pieces(), `${open}${lead}${head}`, tail)
          } finally {
            done?.()
          }
        })(),
      ),
    )
  }
  // `pieces` between `head` and `tail`, a step each, a live region held off
  // meanwhile so each piece goes out as it comes rather than wait for a frame.
  function* written(pieces: Iterable<string>, head: string, tail: string): Generator<void> {
    const release = raw.hold()
    // A piece's last high surrogate waits for the low one that follows: written
    // alone, each half printed as U+FFFD.
    let held = ''
    try {
      raw.write(head)
      for (const piece of pieces) {
        if (piece.length === 0) continue
        let text = held === '' ? piece : held + piece
        held = ''
        const c = text.charCodeAt(text.length - 1)
        if (c >= 0xd800 && c <= 0xdbff) {
          held = text.slice(-1)
          text = text.slice(0, -1)
        }
        if (text.length > 0) {
          raw.write(text)
          yield
        }
      }
      if (held.length > 0) raw.write(held)
      raw.write(`${tail}\n`)
    } finally {
      release()
    }
  }
  // Live-frame close lines end a frame the same way emitBlock does:
  // with a trailing blank line, resetting the separator state.
  // Live frames open now: a warning said inside one is a line of it, not a
  // panel (a "Warnings" header printed between a task's output and its close).
  let liveFrames = 0
  /** Tasks whose live frame `taskStart` opened. */
  const opened = new Set<string>()
  const emitFrameClose = (line: string): void => {
    liveFrames = Math.max(0, liveFrames - 1)
    taskWrite(`${line}\n\n`)
    lineEmitted = false
    streamedSinceBlock = false
  }

  // Focused mode streams requested output live and raw, hit replays included,
  // but only with a single requested task (several would interleave). A
  // requested task, or a dep surfaced from a requested group, is a primary
  // node. Groups never stream.
  const isPrimary = (node: TaskNode): boolean => node.requested || node.surfaced === true
  // A task handed the terminal writes to it directly: the status region goes
  // for good (it would repaint over a prompt), and in framing views a live
  // frame opens before and closes after.
  const holdsTerminal = (node: TaskNode): boolean =>
    opts.tty === true && node.config.exec?.interactive === true
  const framesTerminal = view.mode === 'full' || view.mode === 'focused' || view.mode === 'broad'
  const streamsLive = (node: TaskNode): boolean =>
    (framesTerminal && holdsTerminal(node)) ||
    (view.mode === 'focused' && isPrimary(node) && !isGroupTask(node) && requestedCount <= 1)

  // A frame's `$` line names the task's directory; a run with no root (a
  // test's bare logger) names none.
  const where = (node: TaskNode): { dir?: string } => {
    const root = runContext?.workspaceRoot
    return root === undefined ? {} : { dir: relPosix(root, node.projectDir) }
  }
  // How many tasks are downstream of each: every results row's `blocks`.
  const blocksOf = (id: string): number | undefined => runContext?.blocks?.().get(id)
  // A row's usual time: null for a task history never timed, undefined with no history to ask.
  const usualMsOf = (id: string): number | null | undefined =>
    runContext?.usual === undefined ? undefined : (runContext.usual(id) ?? null)
  const failureRow = (node: TaskNode, outcome: TaskOutcome): string =>
    formatFailureLine(node.id, outcome.durationMs, colors, cacheWordOf(outcome), {
      ...executedCells(outcome, blocksOf(node.id)),
      // A failed restore ran no command: nothing to compare.
      ...(outcome.restoreFailed === true
        ? {}
        : { usual: usualCell(outcome.durationMs, usualMsOf(node.id), colors) }),
      ...(onPath.has(node.id) ? { critical: true } : {}),
    }) + flakyNote(outcome, colors)

  const taskChunk = (node: TaskNode, chunk: string, err: boolean): void => {
    if (discardsOutput) return
    if (streamsLive(node)) {
      streamWrite(chunk)
      return
    }
    const tail = persistentTails.get(node.id)
    if (tail !== undefined) {
      if (printsKept(tail)) streamKept(node, chunk)
      else appendTail(err ? tail.err : tail.out, chunk)
      return
    }
    if (heldOver(node)) return streamKept(node, chunk)
    pushChunk(node.id, chunk, err)
  }
  // Free a task's slot; the longest-waiting queued task (if any) takes it
  // over, keeping lowest-index-first reuse.
  const freeSlot = (id: string): void => {
    const si = slots.findIndex((s) => s !== null && s.id === id)
    if (si >= 0) slots[si] = slotQueue.shift() ?? null
    else {
      const qi = slotQueue.findIndex((s) => s.id === id)
      if (qi >= 0) slotQueue.splice(qi, 1)
    }
  }

  return {
    showsSteps: writer.enabled,
    settle() {
      // The bus delivers one `run:end`, so the CLI's last word reaches here.
      flushKept()
      writer.settle()
      // A logger per run: under `vx watch` each one's file stayed open.
      spool.end()
    },
    status(line) {
      // A kept server's held partial line is older than this line: held
      // past it, a server's last words printed below its own exit notice.
      flushKept()
      flushFailedKept()
      // A live-streamed server keeps writing after its frame closes, so a
      // summary row or "exited with code" can follow its partial line.
      endStreamLine()
      panelOpen = undefined
      // A block's own trailing blank stands for the first blank status line; a second one is meant
      // (two before the Summary).
      if (line === '' && endsBlank) {
        endsBlank = false
        return
      }
      endsBlank = false
      writer.write(`${line}\n`)
    },
    warn(line) {
      flushKept()
      flushFailedKept()
      endStreamLine()
      if (!errColors.enabled || liveFrames > 0) {
        writer.writeTo(errOut, `${ui.tagged('warn', line, errColors)}\n`)
        return
      }
      if (panelOpen !== 'Warnings') {
        writer.writeTo(errOut, `${ui.panelTop('Warnings', errColors)}\n`)
        panelOpen = 'Warnings'
      }
      const rows = line
        .replace(/\n+$/, '')
        .split('\n')
        .map((l) => ui.tagged('warn', l, errColors))
      writer.writeTo(errOut, `${rows.join('\n')}\n`)
    },
    runStart(info) {
      total = info.total
      requestedCount = info.requestedCount ?? requestedCount
      runContext = info.context
      startedAtMs = Date.now()
      started = true
      // No more slots than tasks: `--concurrency=100000000` over six tasks took
      // 80 s per frame, and 2^32 threw.
      slots = Array.from(
        { length: Math.max(1, Math.min(info.concurrency ?? 10, info.total)) },
        () => null,
      )
      tick()
      refresh(true)
    },
    stepStart(id) {
      steps.set(id, runTime())
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
      // Nothing more prints: what no task completed is dropped, and the files close.
      for (const out of outputs.values()) out.release()
      outputs.clear()
      // After any frame still waiting to be written.
      pace.put(once(() => deferredFailures.close()))
      spool.end()
    },
    taskStart(node) {
      if (isGroupTask(node)) return
      if (holdsTerminal(node)) {
        killStatus()
        // What is coalesced lands before the task writes past it.
        writer.settle()
      }
      // Focused flow: a requested node streams raw with the region kept under
      // it, or the summary and run id vanished until the task ended.
      if (streamsLive(node)) {
        // Open the live frame: full task info even when the command
        // streams nothing (or the hit replays nothing).
        emitLine(formatFrameOpen(node, colors, forwardArgs))
        liveFrames++
        opened.add(node.id)
      } else if (node.config.exec?.persistent !== undefined && !persistentTails.has(node.id)) {
        // Bound a persistent task's output from its FIRST chunk. Waiting for
        // its outcome would leave a never-ready one uncapped forever.
        persistentTails.set(node.id, { node, out: createTail(), err: createTail() })
      }
      // The rows are the status region's; with none, nothing reads them.
      if (statusDead) return
      const slot: WorkerSlot = {
        id: node.id,
        startedMs: runTime(),
        cache: ranNoCache({ node }) ? 'no-cache' : 'miss',
      }
      const free = slots.indexOf(null)
      if (free >= 0) slots[free] = slot
      else slotQueue.push(slot)
      refresh(true)
    },
    holdStatus: () => writer.hold(),
    serverKept: (id) => void keptServers.add(id),
    serverStopped: (id) => void stoppedServers.add(id),
    spoolIn: (dir) => spool.in(dir),
    drained: () => pace.drained(),
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
        const escape = notifyEscape(
          failed > 0
            ? `vx: ${failed} of ${total} task${total === 1 ? '' : 's'} failed`
            : `vx: ${total} task${total === 1 ? '' : 's'} done`,
        )
        pace.put(once(() => noteWrite(out, out.write(escape))))
      }
      if (!tail && !statusDead) {
        tail = true
        slots = []
        blocked = undefined
        blockedBy = undefined
        slotQueue.length = 0
        refresh(true)
      } else if (!tail) killStatus()
      // Persistent tails first, as context above the failures they explain.
      // `none` prints none and `errors-only` only failed ones: a server that
      // died on its own is failed by now, so its tail shows. The rest stay
      // captured and bounded. Guarded: an embedder driving a renderer directly
      // may call runEnd twice.
      if (flushedPersistent) flushKept()
      else {
        flushedPersistent = true
        if (view.mode !== 'none') {
          for (const t of persistentTails.values()) {
            // No outcome: still pre-ready, so no since-ready window; its output
            // belongs to the frame it never got.
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
                  stoppedServers.has(t.node.id),
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
      // Failures end the log: each deferred frame replays above the summary,
      // where eyes land. Guarded for repeat runEnd calls.
      if (!flushedFailures && deferredFailures.size > 0) {
        flushedFailures = true
        for (const { note, chars, pieces } of deferredFailures.frames()) {
          // A frame with nothing in it still names its failure.
          if (chars === 0) {
            if (note !== '') logWrite(note)
            continue
          }
          const [open, close] = note === '' && view.gha !== true ? ['', ''] : ghaFenceEnds(ghaToken)
          emitLater(pieces, `${note}${open}`, close, chars < PIECEWISE_CHARS)
        }
        // Once the last frame is written.
        pace.put(once(() => deferredFailures.close()))
      }
      panelOpen = undefined
      // Nothing is held after this; frames may still wait on a slow reader,
      // so a caller writing to the stream itself awaits `drained()` first.
      writer.settle()
    },
    taskStdout: (node, chunk) => taskChunk(node, chunk, false),
    taskStderr: (node, chunk) => taskChunk(node, chunk, true),
    taskComplete(node, outcome) {
      if (!statusDead) finished.add(node.id)
      // A persistent task's frame drains from its bounded tail, with how much
      // the cap dropped: a truncated log must say so.
      const preReady = persistentTails.get(node.id)
      // In the order the task wrote it; a bounded tail kept its streams
      // apart, so its stdout reads first.
      let output: TaskOutput
      if (preReady) {
        output = new TaskOutput(spool)
        output.push(tailText(preReady.out), false)
        output.push(tailText(preReady.err), true)
      } else output = takeOutput(node.id)
      try {
        completeTask(node, outcome, output, preReady)
      } finally {
        output.release()
      }
    },
  }

  function completeTask(
    node: TaskNode,
    outcome: TaskOutcome,
    output: TaskOutput,
    preReady: { out: Tail; err: Tail } | undefined,
  ): void {
    // The live mask releases a held piece after a pause, so a value written
    // in two pieces arrived as two clean chunks: the frame masks each stream
    // whole, as the stored log is.
    const mask =
      !isCacheHit(outcome.status) && output.any
        ? secretMask([process.env, node.config.exec?.env?.define], node.config.exec?.env?.secret)
        : null
    const dropped =
      preReady && (preReady.out.dropped > 0 || preReady.err.dropped > 0)
        ? { droppedStdout: preReady.out.dropped, droppedStderr: preReady.err.dropped }
        : {}
    // The pre-ready window closed either way: a failed task is over, and
    // a ready one starts a fresh post-ready tail below.
    persistentTails.delete(node.id)
    // A short log is read back whole and framed as it always was; a long one
    // is framed as it is read, in pieces, and never held.
    const whole = output.chars < PIECEWISE_CHARS
    let source: OutputSource | undefined
    // Read and masked once, however often the frame and its checks ask.
    let held: OutputChunk[] | undefined
    const heldOutput = (): OutputChunk[] => (held ??= output.held(mask))
    const body = (): TaskBlockBody => ({
      ...(whole ? { output: heldOutput() } : { source: (source ??= output.source(mask)) }),
      ...dropped,
      ...where(node),
    })
    const pieces = (forceCommand: boolean): Iterable<string> =>
      taskBlockPieces(node, outcome, body(), colors, forceCommand, forwardArgs, links)
    // The frame in its turn, between `head` and `tail`; its log kept until then.
    const printFrame = (forceCommand: boolean, head = '', tail = ''): void => {
      output.keep()
      emitLater(
        () => pieces(forceCommand),
        head,
        tail,
        whole,
        () => output.release(),
      )
    }
    // The frame fenced on GitHub Actions.
    const printFenced = (forceCommand: boolean): void => {
      const [open, close] = view.gha === true ? ghaFenceEnds(ghaToken) : ['', '']
      printFrame(forceCommand, open, close)
    }
    // Kept for runEnd; after it, never printed.
    const keepFrame = (forceCommand: boolean, note: string): void => {
      if (!flushedFailures) deferredFailures.add(note, pieces(forceCommand))
    }
    // The failed row now; its frame replays with the others at runEnd.
    const deferFailure = (): void => {
      emitRow(failureRow(node, outcome))
      keepFrame(
        false,
        // The message is ours; only the title carries user input.
        view.gha === true
          ? `::error title=${ghaProperty(node.id)}::${outcomeLabel(outcome)}\n`
          : '',
      )
    }
    // An aborted task frees its slot and counts as the footer will: `aborted`
    // or `not run`.
    if (outcome.status === 'aborted') {
      if (!isGroupTask(node)) {
        if (neverStarted(outcome)) notRun++
        else stopped++
      }
      freeSlot(node.id)
      refresh(true)
      if (isGroupTask(node)) return
      // A stop that reached it before its command (a slow key) still
      // closes the frame its start opened.
      if (neverStarted(outcome) && opened.has(node.id)) {
        emitFrameClose(formatFrameClose(node, outcome, colors))
        return
      }
      // What it printed while stopping (a trap's cleanup) still reaches the
      // terminal: a task trapping Ctrl-C and exiting 0 is aborted, and its
      // frame is dropped. A list view prints a killed task's partial output
      // too: it tells where a run hung.
      const framed =
        !neverStarted(outcome) &&
        (view.mode === 'full' ||
          view.mode === 'broad' ||
          view.mode === 'errors-only' ||
          (view.mode === 'focused' && isPrimary(node)) ||
          (framesTerminal && holdsTerminal(node)))
      if (framed && streamsLive(node)) {
        emitFrameClose(formatFrameClose(node, outcome, colors))
        return
      }
      if (framed && output.any) {
        // A list view treats it as a failure: the row now, the frame
        // with the deferred failures above the summary.
        if (view.mode === 'broad' || view.mode === 'errors-only') {
          emitRow(formatTaskAbortedLine(node, outcome, colors, blocksOf(node.id)))
          keepFrame(true, '')
          return
        }
        printFenced(true)
        return
      }
      // Otherwise a row in the task list, in every view that lists a
      // failure: the run exits red, and the row names why.
      if (view.mode !== 'none' && view.mode !== 'hash-only') {
        emitRow(formatTaskAbortedLine(node, outcome, colors, blocksOf(node.id)))
      }
      return
    }
    // Group tasks (no exec) do no work — no surface prints them.
    if (!isGroupTask(node)) {
      done++
      if (outcome.status === 'failed') {
        failed++
        if (outcome.restoreFailed === true) restoreFailed++
        else if (isKeyFailed(outcome)) keyFailed++
        else if (ranNoCache(outcome)) noCache++
      } else if (node.config.exec?.persistent !== undefined && outcome.status === 'success') {
        // A persistent task's outcome arrives at ready while it keeps
        // running: pin it so its liveness stays visible.
        pinnedPersistent.push(outcome)
        // …and capture what it writes from here. A live-streaming node
        // already owns the terminal; buffering would print twice.
        if (!streamsLive(node)) {
          persistentTails.set(node.id, { node, outcome, out: createTail(), err: createTail() })
        }
      }
      if (!statusDead) freeSlot(node.id)
      // Only a remote's traffic moves a bucket: without one, an entry per
      // task was held for the run and never read.
      const bucket = runContext?.cache?.remote === true ? cacheBucketOf(outcome) : undefined
      if (bucket !== undefined) {
        const entry = { task: node.id, bucket }
        if (outcome.hash !== undefined) buckets.set(outcome.hash, entry)
        buckets.set(node.id, entry)
      }
      switch (outcome.status) {
        case 'success':
          succeeded++
          if (ranNoCache(outcome)) noCache++
          if (outcome.cache?.saved === true) saved++
          else if (ranUnsaved(outcome)) notSaved++
          break
        case 'cache-hit':
          if (outcome.cache?.restored === false) upToDate++
          else restoredLocal++
          break
        case 'cache-hit-remote':
          if (outcome.cache?.restored === false) upToDate++
          else restoredRemote++
          break
        case 'skipped':
          skippedCount++
          break
      }
      if (
        outcome.status === 'success' ||
        (outcome.status === 'failed' && outcome.restoreFailed !== true)
      ) {
        spreadMax = Math.max(spreadMax, outcome.durationMs)
        spreadMin = Math.min(spreadMin, outcome.durationMs)
        spreadSum += outcome.durationMs
        spreadCount++
      }
      refresh(true)
    }
    if (isGroupTask(node)) return
    if (holdsTerminal(node) && streamsLive(node) && outcome.status !== 'skipped') {
      emitFrameClose(formatFrameClose(node, outcome, colors, keptServers.delete(node.id)))
      return
    }
    const isHit = isCacheHit(outcome.status)
    switch (view.mode) {
      case 'none':
        return
      case 'hash-only': {
        // The word carries the outcome; the key is what this mode shows,
        // absent when never computed.
        emitLine(formatTaskHashLine(node, outcome, colors))
        return
      }
      case 'errors-only':
        if (outcome.status === 'skipped') {
          emitRow(formatTaskSkippedLine(node, colors, outcome, blocksOf(node.id)))
          return
        }
        if (outcome.status !== 'failed') return
        deferFailure()
        return
      case 'broad':
        // News only: executed work and skips get a line, failures the frame;
        // hits are silent, counted in the summary.
        if (outcome.status === 'failed') {
          deferFailure()
        } else if (outcome.status === 'success') {
          emitRow(
            formatTaskExecutedLine(
              node,
              outcome,
              colors,
              onPath.has(node.id),
              blocksOf(node.id),
              usualMsOf(node.id),
            ),
          )
          // A ready server's address is news: `vx run dev --all` dropped
          // each server's pre-ready lines, `Local: http://…` among them.
          if (
            node.config.exec?.persistent !== undefined &&
            (whole ? heldOutput().some((c) => c.text.trim().length > 0) : body().source!.content)
          ) {
            printFenced(true)
          }
        } else if (outcome.status === 'skipped') {
          emitRow(formatTaskSkippedLine(node, colors, outcome, blocksOf(node.id)))
        }
        return
      case 'focused':
        if (isPrimary(node)) {
          // Skipped tasks never started, so no frame opened, and a skip has
          // no output: a line says it all.
          if (outcome.status === 'skipped') {
            emitRow(formatTaskSkippedLine(node, colors, outcome, blocksOf(node.id)))
            return
          }
          if (streamsLive(node)) {
            // Single requested task: output streamed live between the
            // frame-open and this close, for every outcome, hits included.
            emitFrameClose(formatFrameClose(node, outcome, colors, keptServers.delete(node.id)))
            return
          }
          // Several requested tasks: no live frame (it would interleave).
          // Failures defer to runEnd; the rest emit one block.
          if (outcome.status === 'failed') {
            deferFailure()
            return
          }
          // forceCommand: a requested task's frame shows `$ cmd`
          // whether it ran or was cached — same frame every run.
          printFenced(true)
          return
        }
        // Dependency-pulled nodes: silent on success; a skip gets its
        // row, failures the failed row now and their frame replayed at runEnd.
        if (outcome.status === 'skipped') {
          emitRow(formatTaskSkippedLine(node, colors, outcome, blocksOf(node.id)))
        } else if (outcome.status === 'failed') {
          deferFailure()
        }
        return
      case 'full': {
        // Hits with nothing to replay are one line, or at 2,000+ tasks frames
        // drown what happened. Hits with output keep their frame; misses and
        // failures always framed. One-liners stay outside `::group::`.
        if (isHit && !output.content) {
          emitRow(formatTaskHitLine(node, outcome, colors, onPath.has(node.id), blocksOf(node.id)))
          return
        }
        if (outcome.status === 'skipped') {
          emitRow(formatTaskSkippedLine(node, colors, outcome, blocksOf(node.id)))
          return
        }
        if (view.gha) {
          // Fenced, so a task printing `::endgroup::` cannot close vx's
          // group, nor `::error` become an annotation.
          const [open, close] = ghaFenceEnds(ghaToken)
          // Failed tasks stay pre-expanded in the Actions viewer: an::error
          // annotation instead of a collapsed group.
          if (outcome.status === 'failed') {
            // The message is ours (a literal, an integer and a signal
            // name); only the title carries user input.
            printFrame(
              false,
              `::error title=${ghaProperty(node.id)}::${outcomeLabel(outcome)}\n${open}`,
              close,
            )
          } else {
            printFrame(
              false,
              `::group::${ghaData(
                `${node.id} (${outcomeWord(outcome)} ${formatElapsed(outcome.durationMs)})`,
              )}\n${open}`,
              `${close}::endgroup::\n`,
            )
          }
          return
        }
        printFrame(false)
        return
      }
    }
  }
}
