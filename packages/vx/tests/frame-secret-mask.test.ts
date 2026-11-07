// A buffered frame printed a secret the live mask let through in two
// pieces: the mask holds a tail that could start a value for 25 ms only,
// so `printf 'C:secretval'; sleep 0.3; printf 'ue1:D\n'` reached the logger
// as two chunks, each clean, and the CI frame showed the whole value while
// the stored log and the hit masked it. The frame prints at completion
// with the whole text in hand, so it masks each stream's whole text.
import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/ui/live-region.js'

function pipe(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: false,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

const node = {
  id: 'p#t',
  projectName: 'p',
  taskName: 't',
  requested: true,
  deps: [],
  config: { exec: { command: 'true', env: { define: { API_TOKEN: 'secretvalue1' } } } },
} as unknown as TaskNode

for (const status of ['success', 'failed'] as const) {
  it(`a ${status} frame masks a value split across chunks`, () => {
    const out = pipe()
    const log = defaultLogger({ enabled: false }, { mode: 'full' }, out, { forceFloorMs: 0 })
    log.runStart?.({ total: 1 })
    log.taskStart?.(node)
    log.taskStdout(node, 'C:secretval')
    log.taskStdout(node, 'ue1:D\n')
    log.taskStderr(node, 'E:secr')
    log.taskStdout(node, 'between\n')
    log.taskStderr(node, 'etvalue1:F\n')
    log.taskComplete(node, {
      node,
      status,
      exitCode: status === 'success' ? 0 : 1,
      durationMs: 1,
    } as TaskOutcome)
    log.runEnd?.()
    log.runDone?.()
    const text = out.text()
    expect(text).toContain('C:***:D')
    expect(text).toContain('E:***')
    expect(text).not.toContain('secretval')
    expect(text).not.toContain('etvalue1')
  })
}
