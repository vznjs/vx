// The live region kept one slot per worker the run was allowed, not per
// task it could run: `--concurrency=100000000` over six trivial tasks took
// 80 s on a terminal and 6 s piped, every frame walking the empty slots,
// and 2^32 threw in runStart, so the renderer drew nothing. A run never
// fills more slots than it has tasks.
import { cpuClock } from './helpers/cpu-clock.js'
import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/ui/live-region.js'

function tty(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: true,
    columns: 100,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

const node = (id: string): TaskNode =>
  ({
    id,
    projectName: id.split('#')[0],
    taskName: id.split('#')[1],
    requested: true,
    deps: [],
    config: { exec: { command: 'true' } },
  }) as unknown as TaskNode

for (const concurrency of [100_000_000, 2 ** 32]) {
  it(`a run of two tasks at --concurrency=${concurrency} draws them at once`, () => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { forceFloorMs: 0 })
    const cpu = cpuClock()
    log.runStart?.({ total: 2, concurrency })
    const a = node('p#a')
    log.taskStart?.(a)
    log.taskComplete(a, { node: a, status: 'success', exitCode: 0, durationMs: 1 } as TaskOutcome)
    log.runEnd?.()
    log.runDone?.()
    expect(cpu()).toBeLessThan(500)
    expect(out.text()).toContain('p#a')
  })
}
