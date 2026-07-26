import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { detectColors, type ColorSupport } from './colors.js'
import {
  formatFrameClose,
  formatFrameOpen,
  formatPersistentTailBlock,
  formatTaskBlock,
  formatTaskExecutedLine,
  formatTaskHitLine,
  formatTaskSkippedLine,
} from './framed-output.js'
import {
  createOutputWriter,
  formatFailureLine,
  formatStatusRegion,
  type StatusStream,
  type WorkerSlot,
} from './status-line.js'
import { formatDuration, formatSummarySection, type RunContext } from './summary.js'
import { isGroupTask } from '../graph/index.js'

export interface Logger {
  /** Header / footer / status text. Written verbatim, one trailing \n added. */
  status(line: string): void
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
  /** Run finished (any outcome). Idempotent. */
  runEnd?(): void
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
 *   focused     — requested nodes stream raw output live (running the
 *                 task should feel like running the command directly);
 *                 dependency-pulled nodes are silent unless they fail.
 *   broad       — news only: one `success` line per executed task,
 *                 full frames for failures, silence for cache hits.
 *
 * `gha` (full mode only): wrap each task's block in `::group::` /
 * `::endgroup::` workflow commands so tasks collapse in the GitHub
 * Actions log viewer — except failed tasks, which stay pre-expanded
 * and emit an `::error` annotation instead.
 *
 * `ci`: a truthy CI env was detected. Suppresses the dynamic status
 * line even if stdout happens to be a TTY.
 */
export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad'
  gha?: boolean
  ci?: boolean
}

/** CI=0 / CI=false count as "not CI" — several vendors use CI=true. */
function truthyEnv(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}

/**
 * Per-stream cap on the output a persistent task writes AFTER its outcome
 * lands. A dev server or watcher runs for the rest of the run and can log
 * without bound, so the tail keeps only the most recent slice — the part
 * that explains whatever just failed against it.
 */
const PERSISTENT_TAIL_CHARS = 64 * 1024

/** Bounded head-evicting tail for one stream of one still-running task. */
interface Tail {
  chunks: string[]
  chars: number
  dropped: number
}

function appendTail(t: Tail, chunk: string): void {
  if (chunk.length === 0) return
  t.chunks.push(chunk)
  t.chars += chunk.length
  // Evict WHOLE chunks from the head — no concatenation until the flush
  // joins once, so a chatty server costs one array push per chunk.
  while (t.chars > PERSISTENT_TAIL_CHARS && t.chunks.length > 1) {
    const gone = t.chunks.shift()!
    t.chars -= gone.length
    t.dropped += gone.length
  }
  // A single chunk over the cap is the one place we copy.
  if (t.chars > PERSISTENT_TAIL_CHARS) {
    const only = t.chunks[0]!
    const keep = only.slice(only.length - PERSISTENT_TAIL_CHARS)
    t.dropped += only.length - keep.length
    t.chunks[0] = keep
    t.chars = keep.length
  }
}

/** The unified outcome vocabulary word for a non-failed outcome. */
function outcomeWord(o: TaskOutcome): string {
  switch (o.status) {
    case 'success':
      return 'success'
    case 'cache-hit':
      return o.restored === false ? 'up-to-date' : 'restored-local'
    case 'cache-hit-remote':
      return o.restored === false ? 'up-to-date' : 'restored-remote'
    default:
      return o.status
  }
}

export function resolveOutputView(
  options: { outputLogs?: 'full' | 'errors-only' | 'none'; flow?: 'focused' | 'broad' },
  env: Record<string, string | undefined> = process.env,
): OutputView {
  const ci = truthyEnv(env['CI'])
  const gha = truthyEnv(env['GITHUB_ACTIONS'])
  const mk = (mode: OutputView['mode']): OutputView => ({
    mode,
    ...(mode === 'full' && gha ? { gha: true } : {}),
    ...(ci ? { ci: true } : {}),
  })
  if (options.outputLogs !== undefined) return mk(options.outputLogs)
  if (ci) return mk('full')
  if (options.flow !== undefined) return mk(options.flow)
  return mk('full')
}

export function defaultLogger(
  colors: ColorSupport = detectColors(),
  view: OutputView = { mode: 'full' },
  out: StatusStream = process.stdout,
  opts: { forceFloorMs?: number } = {},
): Logger {
  // Per-task buffers, split by stream. Splitting lets the framed-output
  // renderer put stdout under `├─ stdout` and stderr under `├─ stderr`.
  // The price: chunks that interleaved at runtime get re-ordered (all
  // stdout before all stderr).
  //
  // Chunks are held as a string[] (push + join on flush) instead of
  // appending via `+=`; concatenating N small chunks via `+=` is O(N²)
  // because each `+=` allocates a fresh string of the full accumulated
  // length. Bun-friendly: join('') is a single contiguous allocation.
  const stdoutBuffers = new Map<string, string[]>()
  const stderrBuffers = new Map<string, string[]>()
  // Separator bookkeeping: blocks are blank-line-delimited on BOTH
  // sides — raw (unprefixed) frame content must never collide with a
  // neighbouring one-liner (owner feedback). A block leaves its own
  // trailing blank, so a block following a block needs no leading one;
  // a one-liner or streamed output since the last block does.
  let lineEmitted = false
  let streamedSinceBlock = false
  // Ids whose output went straight to the terminal (focused mode).
  const streamed = new Set<string>()
  // True while the live stream sits mid-line (chunk without trailing
  // newline) — the frame close must not glue onto partial output.
  let streamMidLine = false
  const pushChunk = (buffers: Map<string, string[]>, id: string, chunk: string): void => {
    const arr = buffers.get(id)
    if (arr) arr.push(chunk)
    else buffers.set(id, [chunk])
  }
  const takeChunks = (buffers: Map<string, string[]>, id: string): string => {
    const arr = buffers.get(id)
    if (!arr) return ''
    buffers.delete(id)
    return arr.length === 1 ? arr[0]! : arr.join('')
  }

  // All stdout flows through the writer so the status line can never
  // interleave with content. Inert (pure passthrough) on non-TTY
  // streams and in CI.
  const writer = createOutputWriter(out, {
    enabled: view.ci !== true,
    ...(opts.forceFloorMs !== undefined ? { forceFloorMs: opts.forceFloorMs } : {}),
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

  // Every interactive view renders the fixed-height worker region:
  // one row per worker slot so a task's name never moves while it
  // runs (the display derives from the stable worker set, not the
  // churning task set). Sized at runStart from concurrency, capped at
  // 10 rows; excess running tasks queue for a freed slot and surface
  // as `+k more` on the stats line. Focused flow keeps its lifecycle:
  // the region dies the moment a requested node starts streaming.
  let slots: (WorkerSlot | null)[] = []
  const slotQueue: WorkerSlot[] = []
  let succeeded = 0
  let upToDate = 0
  let restoredLocal = 0
  let restoredRemote = 0
  let skippedCount = 0
  // Cache-miss duration spread, accumulated incrementally (the same
  // numbers the final summary computes from the outcome list).
  let spreadMax = 0
  let spreadMin = Infinity
  let spreadSum = 0
  let spreadCount = 0
  // Pinned zones above the worker rows: failures accumulate as they
  // happen; persistent tasks pin at ready (their outcome lands while
  // the child keeps running). Both live until runEnd kills the region.
  // Full failure frames, deferred to runEnd (owner: '✗ line, continue,
  // all full frames at the end'). 'full'/CI keeps frames inline.
  const deferredFailures: string[] = []
  const pinnedPersistent: string[] = []
  let flushedFailures = false
  // A persistent task's outcome lands at READY while its child keeps
  // writing. Those chunks used to land back in the per-task buffers that
  // `taskComplete` had already drained, so nothing ever emitted them and
  // nothing ever freed them: invisible in every view but a live-streaming
  // focused one, and retained for the rest of the run. Post-ready chunks
  // route here instead — bounded, and flushed as one trailing block at
  // runEnd. Registration is unconditional (the bound is a memory
  // invariant, not a display choice); only the flush is view-gated.
  const persistentTails = new Map<
    string,
    { node: TaskNode; outcome: TaskOutcome; out: Tail; err: Tail }
  >()
  let flushedPersistent = false

  const refresh = (force: boolean): void => {
    if (statusDead) return
    // The live summary IS the final summary's section, built from the
    // same formatter so the region visually becomes the printout.
    const summaryLines = formatSummarySection(
      {
        failed,
        successful: succeeded + upToDate + restoredLocal + restoredRemote,
        skipped: skippedCount,
        total,
        upToDate,
        restoredLocal,
        restoredRemote,
        miss: succeeded + failed,
        left: total - done,
        spread:
          spreadCount > 0
            ? { maxMs: spreadMax, minMs: spreadMin, sumMs: spreadSum, count: spreadCount }
            : null,
      },
      Date.now() - startedAtMs,
      colors,
      runContext,
    )
    writer.setRegion(
      formatStatusRegion(
        {
          pinnedPersistent,
          slots,
          overflow: slotQueue.length,
          nowMs: Date.now(),
          summaryLines,
        },
        colors,
      ),
      { force },
    )
  }
  const killStatus = (): void => {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
    if (statusDead) return
    statusDead = true
    writer.clearStatus()
  }

  const emitLine = (line: string): void => {
    writer.write(`${line}\n`)
    lineEmitted = true
  }
  // formatTaskBlock returns '' for group tasks (no exec) — skip the
  // write so a stray newline doesn't sneak into the output.
  const emitBlock = (block: string): void => {
    if (block.length === 0) return
    const lead = lineEmitted || streamedSinceBlock ? '\n' : ''
    writer.write(`${lead}${block}\n`)
    lineEmitted = false
    streamedSinceBlock = false
  }
  // Live-frame close lines end a frame the same way emitBlock does:
  // with a trailing blank line, resetting the separator state.
  const emitFrameClose = (line: string): void => {
    writer.write(`${line}\n\n`)
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
  const streamsLive = (node: TaskNode): boolean =>
    view.mode === 'focused' && isPrimary(node) && !isGroupTask(node) && requestedCount <= 1

  return {
    status(line) {
      writer.write(`${line}\n`)
    },
    runStart(info) {
      total = info.total
      requestedCount = info.requestedCount ?? requestedCount
      runContext = info.context
      startedAtMs = Date.now()
      const cap = Math.max(1, Math.min(info.concurrency ?? 10, 10))
      slots = Array.from({ length: cap }, () => null)
      if (writer.enabled && !statusDead && ticker === null) {
        // Keeps the per-worker elapsed time ticking between task events
        // (the time IS the motion — there's no spinner). The writer
        // throttles unforced redraws, and unref means a stray ticker
        // can never hold the process open.
        ticker = setInterval(() => {
          refresh(false)
        }, 100)
        ticker.unref?.()
      }
      refresh(true)
    },
    taskStart(node) {
      if (isGroupTask(node)) return
      // Focused flow: the status line exists for the dependency
      // phase only. The moment a requested node starts streaming,
      // clear it for good — its raw output owns the terminal now.
      if (streamsLive(node)) {
        killStatus()
        // Open the live frame: full task info even when the command
        // streams nothing (or the hit replays nothing).
        emitLine(formatFrameOpen(node, colors))
        return
      }
      const slot: WorkerSlot = { id: node.id, startedMs: Date.now() }
      const free = slots.indexOf(null)
      if (free >= 0) slots[free] = slot
      else slotQueue.push(slot)
      refresh(true)
    },
    runEnd() {
      killStatus()
      // Persistent tails first: they are context for whatever ran against
      // the server, so they read above the failures they explain. `none`
      // and `errors-only` state their contracts absolutely (no per-task
      // output / only failed tasks print), so they stay silent — the tail
      // is still captured and still bounded, just never printed. Guarded
      // like the failures below: run() calls runEnd twice on the success
      // path (once before the summary, once in its finally), and a
      // kept-alive child keeps writing between the two.
      if (!flushedPersistent) {
        flushedPersistent = true
        if (view.mode !== 'none' && view.mode !== 'errors-only') {
          for (const t of persistentTails.values()) {
            emitBlock(
              formatPersistentTailBlock(
                t.node,
                t.outcome,
                { stdout: t.out.chunks.join(''), stderr: t.err.chunks.join('') },
                { stdout: t.out.dropped, stderr: t.err.dropped },
                colors,
              ),
            )
          }
        }
        for (const t of persistentTails.values()) {
          t.out.chunks.length = 0
          t.err.chunks.length = 0
          t.out.chars = 0
          t.err.chars = 0
        }
      }
      // Failures end the log: every deferred frame replays here, right
      // above the summary — the ✗ one-liners marked them in the
      // stream, the full diagnostics read last where eyes land.
      // Guarded for repeat runEnd calls.
      if (!flushedFailures && deferredFailures.length > 0) {
        flushedFailures = true
        for (const block of deferredFailures) emitBlock(block)
      }
    },
    taskStdout(node, chunk) {
      if (streamsLive(node)) {
        streamed.add(node.id)
        streamedSinceBlock = true
        if (chunk.length > 0) streamMidLine = !chunk.endsWith('\n')
        writer.write(chunk)
        return
      }
      const tail = persistentTails.get(node.id)
      if (tail !== undefined) {
        appendTail(tail.out, chunk)
        return
      }
      pushChunk(stdoutBuffers, node.id, chunk)
    },
    taskStderr(node, chunk) {
      if (streamsLive(node)) {
        streamed.add(node.id)
        streamedSinceBlock = true
        if (chunk.length > 0) streamMidLine = !chunk.endsWith('\n')
        writer.write(chunk)
        return
      }
      const tail = persistentTails.get(node.id)
      if (tail !== undefined) {
        appendTail(tail.err, chunk)
        return
      }
      pushChunk(stderrBuffers, node.id, chunk)
    },
    taskComplete(node, outcome) {
      const stdout = takeChunks(stdoutBuffers, node.id)
      const stderr = takeChunks(stderrBuffers, node.id)
      // An aborted task (child killed by a shutdown signal) reverts
      // to pending: free its worker slot, but never count or render it
      // — the run is tearing down and it has no honest outcome.
      if (outcome.status === 'aborted') {
        const si = slots.findIndex((s) => s !== null && s.id === node.id)
        if (si >= 0) slots[si] = slotQueue.shift() ?? null
        else {
          const qi = slotQueue.findIndex((s) => s.id === node.id)
          if (qi >= 0) slotQueue.splice(qi, 1)
        }
        refresh(true)
        return
      }
      // Group tasks (no exec) do no work — no surface prints them.
      if (!isGroupTask(node)) {
        done++
        if (outcome.status === 'failed') {
          failed++
        } else if (node.config.exec?.persistent !== undefined && outcome.status === 'success') {
          // A persistent task's outcome arrives at READY; the child
          // keeps running until the orchestrator SIGTERMs it at run
          // end — pin it so its liveness stays visible.
          pinnedPersistent.push(node.id)
          // …and capture what it writes from here on. A live-streaming
          // node already owns the terminal, so buffering it would emit
          // its output twice.
          if (!streamsLive(node)) {
            persistentTails.set(node.id, {
              node,
              outcome,
              out: { chunks: [], chars: 0, dropped: 0 },
              err: { chunks: [], chars: 0, dropped: 0 },
            })
          }
        }
        // Free the task's slot; the longest-waiting queued task
        // (if any) takes it over, keeping lowest-index-first reuse.
        const si = slots.findIndex((s) => s !== null && s.id === node.id)
        if (si >= 0) slots[si] = slotQueue.shift() ?? null
        else {
          const qi = slotQueue.findIndex((s) => s.id === node.id)
          if (qi >= 0) slotQueue.splice(qi, 1)
        }
        switch (outcome.status) {
          case 'success':
            succeeded++
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
      const isHit = outcome.status === 'cache-hit' || outcome.status === 'cache-hit-remote'
      switch (view.mode) {
        case 'none':
          return
        case 'errors-only':
          if (outcome.status !== 'failed') return
          emitLine(formatFailureLine(node.id, outcome.durationMs, colors))
          deferredFailures.push(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          return
        case 'broad':
          // News only: executed work gets a one-liner, failures get
          // the full frame. Hits (including up-to-date) are silent —
          // their replay buffers are deliberately dropped; the counts
          // surface in the end-of-run summary.
          if (outcome.status === 'failed') {
            // ✗ marker now; the full frame replays at runEnd.
            emitLine(formatFailureLine(node.id, outcome.durationMs, colors))
            deferredFailures.push(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          } else if (outcome.status === 'success') {
            emitLine(formatTaskExecutedLine(node, outcome, colors))
          }
          return
        case 'focused':
          if (isPrimary(node)) {
            // Skipped tasks never started (upstream failed), so no
            // frame-open fired — and a skip has no output, so a
            // one-liner carries everything a frame would.
            if (outcome.status === 'skipped') {
              emitLine(formatTaskSkippedLine(node, colors))
              return
            }
            if (streamsLive(node)) {
              // Single requested task: output (exec or hit replay)
              // streamed live between the frame-open (taskStart) and
              // this close — full task info for every outcome, cached
              // and up-to-date included (owner: "always full frame
              // for a single task").
              if (streamMidLine) {
                writer.write('\n')
                streamMidLine = false
              }
              emitFrameClose(formatFrameClose(node, outcome, colors))
              return
            }
            // Multiple requested tasks: no live frame was opened (it
            // would interleave with siblings). Failures still defer
            // to runEnd like everywhere else; everything else emits
            // ONE atomic block from the buffered output.
            if (outcome.status === 'failed') {
              emitLine(formatFailureLine(node.id, outcome.durationMs, colors))
              deferredFailures.push(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
              return
            }
            // forceCommand: a requested task's frame shows `$ cmd`
            // whether it ran or was cached — same frame every run.
            emitBlock(formatTaskBlock(node, outcome, { stdout, stderr }, colors, true))
            return
          }
          // Dependency-pulled nodes: silent on success; failures get
          // the ✗ marker now and their frame replayed at runEnd.
          if (outcome.status === 'failed') {
            emitLine(formatFailureLine(node.id, outcome.durationMs, colors))
            deferredFailures.push(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          }
          return
        case 'full': {
          // Cache hits with nothing to replay compress to ONE line —
          // every task stays visible, but at 2000+ tasks the two-line
          // frames would drown what actually happened. Hits WITH
          // replayed stdout keep their frame (the output is the
          // point); misses/failures are always framed. One-liners
          // stay outside ::group:: — there's nothing to collapse.
          if (isHit && stdout.trim().length === 0 && stderr.trim().length === 0) {
            emitLine(formatTaskHitLine(node, outcome, colors))
            return
          }
          if (outcome.status === 'skipped') {
            emitLine(formatTaskSkippedLine(node, colors))
            return
          }
          const block = formatTaskBlock(node, outcome, { stdout, stderr }, colors)
          if (block.length === 0) return
          if (view.gha) {
            // Failed tasks stay pre-expanded in the Actions viewer:
            // an ::error annotation instead of a collapsed group.
            if (outcome.status === 'failed') {
              emitBlock(`::error title=${node.id}::failed (exit ${outcome.exitCode})\n${block}`)
            } else {
              emitBlock(
                `::group::${node.id} (${outcomeWord(outcome)} ${formatDuration(outcome.durationMs)})\n` +
                  `${block}::endgroup::\n`,
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
