// Tasks run with FORCE_COLOR, so wherever vx's own output is plain their
// escapes are stripped on the way to the logger: whole, cut across chunks,
// and never at the cost of a character of text.

import { describe, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { Logger } from '../src/orchestrator/logger.js'
import { plainOutput } from '../src/orchestrator/plain-output.js'

const A = { id: 'a#build' } as TaskNode
const B = { id: 'b#build' } as TaskNode
const DONE = { status: 'success' } as unknown as TaskOutcome

function recorder() {
  const calls: string[] = []
  const sink: Logger = {
    status: (l) => calls.push(`status ${l}`),
    taskStdout: (n, c) => calls.push(`out ${n.id} ${JSON.stringify(c)}`),
    taskStderr: (n, c) => calls.push(`err ${n.id} ${JSON.stringify(c)}`),
    taskComplete: (n) => calls.push(`done ${n.id}`),
  }
  return { calls, log: plainOutput(sink) }
}

describe('plainOutput', () => {
  it('strips CSI and OSC, and passes text without escapes through untouched', () => {
    const { calls, log } = recorder()
    log.taskStdout(A, 'plain\n')
    log.taskStdout(A, '\x1b[1;31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07\n')
    log.taskStderr(A, '\x1b[33mwarn\x1b[39m\n')
    expect(calls).toEqual([
      'out a#build "plain\\n"',
      'out a#build "red link\\n"',
      'err a#build "warn\\n"',
    ])
  })

  it('holds an escape cut at a chunk end for the next chunk, per task and stream', () => {
    const { calls, log } = recorder()
    log.taskStdout(A, 'x\x1b[3')
    log.taskStdout(B, 'y\x1b')
    log.taskStderr(A, 'e\x1b]8;;http')
    log.taskStdout(A, '1mred\x1b[0m\n')
    log.taskStdout(B, '[2mdim\n')
    log.taskStderr(A, '://x\x07z\n')
    expect(calls).toEqual([
      'out a#build "x"',
      'out b#build "y"',
      'err a#build "e"',
      'out a#build "red\\n"',
      'out b#build "dim\\n"',
      'err a#build "z\\n"',
    ])
  })

  it('a cut escape still held at completion is flushed stripped before the block', () => {
    const { calls, log } = recorder()
    log.taskStdout(A, 'tail\x1b[')
    log.taskComplete(A, DONE)
    expect(calls).toEqual(['out a#build "tail"', 'done a#build'])
  })

  it('a lone ESC that can complete nothing is stripped, not held', () => {
    const { calls, log } = recorder()
    log.taskStdout(A, 'a\x1bxyz\n')
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('\\u001b')
    expect(calls[0]).toContain('yz\\n')
  })

  it("delegates a class logger's prototype hooks with their `this`", () => {
    const seen: string[] = []
    class Log implements Logger {
      private readonly tag = 'mine'
      status(l: string) {
        seen.push(`${this.tag} ${l}`)
      }
      taskStdout() {}
      taskStderr() {}
      taskComplete() {}
      runEnd() {
        seen.push(`${this.tag} end`)
      }
    }
    const log = plainOutput(new Log())
    log.status('s')
    log.runEnd?.()
    expect(seen).toEqual(['mine s', 'mine end'])
    expect(log.taskStart).toBeUndefined()
  })
})
