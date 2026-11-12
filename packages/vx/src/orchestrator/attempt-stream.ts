// One attempt's output: streamed to the logger chunk by chunk, both streams
// kept in the order they arrived, at the entry's bounds when the task will
// keep it whole (a save, a run log) and as a failure's head and tail else.

import { BoundedCapture } from '../exec/index.js'
import type { TaskNode } from '../graph/index.js'
import type { Logger } from '../report/index.js'
import { maskedStreams, type SecretMask } from '../util/index.js'
import {
  encodeOutputLog,
  FAILED_OUTPUT_HEAD_CHARS,
  FAILED_OUTPUT_TAIL_CHARS,
} from './output-log.js'
import { taskLogMasks } from './telemetry.js'

export interface StreamSnapshot {
  readonly output: BoundedCapture | undefined
  readonly flushMasked: () => void
}

export class AttemptStream {
  /** The attempt's output as the logger got it (masked). */
  output: BoundedCapture | undefined
  /**
   * The output last ended mid-line: vx's own line (a retry, a timeout, the
   * shell's verdict, an abandoned executor) starts its own, and only then.
   * Glued, a frame read `partialvx: retrying …`.
   */
  midLine = false
  /** The last stderr: the shell's "not found" line names the word a compound command missed. */
  errTail = ''
  /** The last of both streams: a failure's own words name a variable the task was not given (`unpassedEnv`). */
  tail = ''
  /** Ends the masked streams, letting go what they held back. */
  flushMasked: () => void = () => {}

  constructor(
    private readonly node: TaskNode,
    private readonly log: Logger,
  ) {}

  /** A new attempt's capture; returns the request's two callbacks. */
  open(
    whole: boolean,
    secrets: SecretMask | null,
  ): { onStdout: (t: string) => void; onStderr: (t: string) => void } {
    const { node, log } = this
    const kept = whole
      ? new BoundedCapture()
      : new BoundedCapture(FAILED_OUTPUT_HEAD_CHARS, FAILED_OUTPUT_TAIL_CHARS)
    this.output = kept
    this.midLine = false
    this.errTail = ''
    this.tail = ''
    const toOut = (t: string): void => {
      kept.push(t)
      this.tail = (this.tail + t).slice(-4096)
      if (t.length > 0) this.midLine = !t.endsWith('\n')
      log.taskStdout(node, t)
    }
    const toErr = (t: string): void => {
      kept.push(t, true)
      if (t.length > 0) this.midLine = !t.endsWith('\n')
      this.errTail = (this.errTail + t).slice(-2048)
      this.tail = (this.tail + t).slice(-4096)
      log.taskStderr(node, t)
    }
    if (secrets) taskLogMasks.set(node, secrets)
    const masked = secrets && maskedStreams(secrets, toOut, toErr)
    this.flushMasked = () => masked?.end()
    return { onStdout: masked ? masked.out : toOut, onStderr: masked ? masked.err : toErr }
  }

  /** A newline when the output last ended mid-line. */
  nl(): string {
    return this.midLine ? '\n' : ''
  }

  /** Masked again whole: the live stream lets a held piece go after a pause. */
  stored(secrets: SecretMask | null): string {
    return encodeOutputLog(this.output?.chunks() ?? [], secrets ?? undefined)
  }

  snapshot(): StreamSnapshot {
    return { output: this.output, flushMasked: this.flushMasked }
  }

  restore(s: StreamSnapshot): void {
    this.output = s.output
    this.flushMasked = s.flushMasked
  }
}
