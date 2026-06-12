import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { detectColors, type ColorSupport } from './colors.js'
import {
  formatFrameClose,
  formatFrameOpen,
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
import { formatDuration } from './summary.js'
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
  runStart?(info: { total: number; concurrency?: number }): void
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
  let spinnerFrame = 0
  let succeeded = 0
  let upToDate = 0
  let restoredLocal = 0
  let restoredRemote = 0
  // Pinned zones above the worker rows: failures accumulate as they
  // happen; persistent tasks pin at ready (their outcome lands while
  // the child keeps running). Both live until runEnd kills the region.
  // Full failure frames, deferred to runEnd (owner: '✗ line, continue,
  // all full frames at the end'). 'full'/CI keeps frames inline.
  const deferredFailures: string[] = []
  const pinnedPersistent: string[] = []
  let flushedFailures = false

  const refresh = (force: boolean): void => {
    if (statusDead) return
    writer.setRegion(
      formatStatusRegion(
        {
          pinnedPersistent,
          slots,
          done,
          total,
          succeeded,
          upToDate,
          restoredLocal,
          restoredRemote,
          failed,
          overflow: slotQueue.length,
          elapsedMs: Date.now() - startedAtMs,
          nowMs: Date.now(),
          spinnerFrame,
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
  // streams identically.
  const streamsLive = (node: TaskNode): boolean =>
    view.mode === 'focused' && node.requested && !isGroupTask(node)

  return {
    status(line) {
      writer.write(`${line}\n`)
    },
    runStart(info) {
      total = info.total
      startedAtMs = Date.now()
      const cap = Math.max(1, Math.min(info.concurrency ?? 10, 10))
      slots = Array.from({ length: cap }, () => null)
      if (writer.enabled && !statusDead && ticker === null) {
        // Keeps the elapsed counter + spinner moving between task
        // events. The writer throttles unforced redraws, and unref
        // means a stray ticker can never hold the process open.
        ticker = setInterval(() => {
          spinnerFrame++
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
      pushChunk(stderrBuffers, node.id, chunk)
    },
    taskComplete(node, outcome) {
      const stdout = takeChunks(stdoutBuffers, node.id)
      const stderr = takeChunks(stderrBuffers, node.id)
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
          emitLine(formatFailureLine(node.id, outcome.exitCode, colors))
          deferredFailures.push(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          return
        case 'broad':
          // News only: executed work gets a one-liner, failures get
          // the full frame. Hits (including up-to-date) are silent —
          // their replay buffers are deliberately dropped; the counts
          // surface in the end-of-run summary.
          if (outcome.status === 'failed') {
            // ✗ marker now; the full frame replays at runEnd.
            emitLine(formatFailureLine(node.id, outcome.exitCode, colors))
            deferredFailures.push(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          } else if (outcome.status === 'success') {
            emitLine(formatTaskExecutedLine(node, outcome, colors))
          }
          return
        case 'focused':
          if (node.requested) {
            // Skipped tasks never started (upstream failed), so no
            // frame-open fired — and a skip has no output, so a
            // one-liner carries everything a frame would.
            if (outcome.status === 'skipped') {
              emitLine(formatTaskSkippedLine(node, colors))
              return
            }
            // Output (exec or hit replay) streamed live between the
            // frame-open (taskStart) and this close — full task info
            // for every outcome, cached and up-to-date included
            // (owner: "always full frame for a single task").
            if (streamMidLine) {
              writer.write('\n')
              streamMidLine = false
            }
            emitFrameClose(formatFrameClose(node, outcome, colors))
            return
          }
          // Dependency-pulled nodes: silent on success; failures get
          // the ✗ marker now and their frame replayed at runEnd.
          if (outcome.status === 'failed') {
            emitLine(formatFailureLine(node.id, outcome.exitCode, colors))
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
