import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { detectColors, type ColorSupport } from './colors.js'
import { formatTaskBlock, formatTaskExecutedLine, formatTaskHitLine } from './framed-output.js'
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
 *   broad       — news only: one `executed` line per executed task,
 *                 full frames for failures, silence for cache hits.
 *
 * `gha` (full mode only): wrap each task's block in `::group::` /
 * `::endgroup::` workflow commands so tasks collapse in the GitHub
 * Actions log viewer — except failed tasks, which stay pre-expanded
 * and emit an `::error` annotation instead.
 */
export type OutputView =
  | { mode: 'full'; gha?: boolean }
  | { mode: 'errors-only' }
  | { mode: 'none' }
  | { mode: 'focused' }
  | { mode: 'broad' }

/** CI=0 / CI=false count as "not CI" — several vendors use CI=true. */
function truthyEnv(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}

/** The unified outcome vocabulary word for a non-failed outcome. */
function outcomeWord(o: TaskOutcome): string {
  switch (o.status) {
    case 'success':
      return 'executed'
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
  const gha = truthyEnv(env['GITHUB_ACTIONS'])
  const full = (): OutputView => (gha ? { mode: 'full', gha: true } : { mode: 'full' })
  if (options.outputLogs !== undefined) {
    return options.outputLogs === 'full' ? full() : { mode: options.outputLogs }
  }
  if (truthyEnv(env['CI'])) return full()
  if (options.flow !== undefined) return { mode: options.flow }
  return full()
}

export function defaultLogger(
  colors: ColorSupport = detectColors(),
  view: OutputView = { mode: 'full' },
  out: { write(chunk: string): unknown } = process.stdout,
): Logger {
  // Per-task buffers, split by stream. Splitting lets the framed-output
  // renderer put stdout in the body and stderr under an `├─ Error`
  // section. The price: chunks that interleaved at runtime get
  // re-ordered (all stdout before all stderr).
  //
  // Chunks are held as a string[] (push + join on flush) instead of
  // appending via `+=`; concatenating N small chunks via `+=` is O(N²)
  // because each `+=` allocates a fresh string of the full accumulated
  // length. Bun-friendly: join('') is a single contiguous allocation.
  const stdoutBuffers = new Map<string, string[]>()
  const stderrBuffers = new Map<string, string[]>()
  // Separator bookkeeping: frames get a leading blank line whenever
  // anything (a previous frame, a one-liner, streamed output) was
  // already emitted. The header (formatHeader) already ends with a
  // blank line, so the first block doesn't need one.
  let blocksEmitted = 0
  let lineEmitted = false
  let streamedSinceBlock = false
  // Ids whose output went straight to the terminal (focused mode).
  const streamed = new Set<string>()
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

  const emitLine = (line: string): void => {
    out.write(`${line}\n`)
    lineEmitted = true
  }
  // formatTaskBlock returns '' for group tasks (no exec) — skip the
  // write so a stray newline doesn't sneak into the output.
  const emitBlock = (block: string): void => {
    if (block.length === 0) return
    out.write(blocksEmitted > 0 || lineEmitted || streamedSinceBlock ? `\n${block}` : block)
    blocksEmitted++
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
      out.write(`${line}\n`)
    },
    taskStdout(node, chunk) {
      if (streamsLive(node)) {
        streamed.add(node.id)
        streamedSinceBlock = true
        out.write(chunk)
        return
      }
      pushChunk(stdoutBuffers, node.id, chunk)
    },
    taskStderr(node, chunk) {
      if (streamsLive(node)) {
        streamed.add(node.id)
        streamedSinceBlock = true
        out.write(chunk)
        return
      }
      pushChunk(stderrBuffers, node.id, chunk)
    },
    taskComplete(node, outcome) {
      const stdout = takeChunks(stdoutBuffers, node.id)
      const stderr = takeChunks(stderrBuffers, node.id)
      // Group tasks (no exec) do no work — no surface prints them.
      if (isGroupTask(node)) return
      const isHit = outcome.status === 'cache-hit' || outcome.status === 'cache-hit-remote'
      switch (view.mode) {
        case 'none':
          return
        case 'errors-only':
          if (outcome.status !== 'failed') return
          emitBlock(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          return
        case 'broad':
          // News only: executed work gets a one-liner, failures get
          // the full frame. Hits (including up-to-date) are silent —
          // their replay buffers are deliberately dropped; the counts
          // surface in the end-of-run summary.
          if (outcome.status === 'failed') {
            emitBlock(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
          } else if (outcome.status === 'success') {
            emitLine(formatTaskExecutedLine(node, outcome, colors))
          }
          return
        case 'focused':
          if (node.requested) {
            // Output (exec or hit replay) already streamed live. A
            // quiet hit never streamed anything — the one-liner is its
            // only trace. Skips are framed: the task never produced
            // output, and "didn't run" is exactly the news.
            if (isHit && !streamed.has(node.id)) {
              emitLine(formatTaskHitLine(node, outcome, colors))
            } else if (outcome.status === 'skipped') {
              emitBlock(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
            }
            return
          }
          // Dependency-pulled nodes: silent on success, framed on
          // failure (the buffered output is the evidence).
          if (outcome.status === 'failed') {
            emitBlock(formatTaskBlock(node, outcome, { stdout, stderr }, colors))
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
