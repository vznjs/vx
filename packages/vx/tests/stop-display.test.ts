// 2026-10-17: a Ctrl-C blanked the live region until the summary, so a
// slow stop looked hung. Now the region stays: running rows say
// `aborting` with their timers, blocked and idle rows leave, each task
// that exits is an `aborted` row, and the footer replaces the region.

import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/report/status-line.js'

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

const ERASE = '\x1b[J'
const node = (task: string): TaskNode =>
  ({
    id: `p#${task}`,
    deps: [],
    projectName: 'p',
    taskName: task,
    requested: true,
    config: { exec: { command: 'true' }, cache: {} },
  }) as unknown as TaskNode
const region = (out: { text(): string }): string => out.text().slice(out.text().lastIndexOf(ERASE))

it('a stop keeps the region: running rows say aborting, exited ones aborted', async () => {
  const out = tty()
  const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { forceFloorMs: 0 })
  log.runStart?.({ total: 3, concurrency: 3 })
  const [a, b] = [node('a'), node('b')]
  log.taskStart?.(a)
  log.taskStart?.(b)
  expect(region(out)).toContain('running')

  log.runStop?.()
  const stopping = region(out)
  expect(stopping).toContain('aborting')
  expect(stopping).not.toContain('running')
  expect(stopping).not.toContain('idle')
  expect(stopping).toContain('p#a')
  expect(stopping).toContain('p#b')

  log.taskComplete(a, {
    node: a,
    status: 'aborted',
    exitCode: 130,
    durationMs: 1200,
    wallclockStartNs: 1n,
  } as TaskOutcome)
  const text = out.text()
  const row = text.slice(text.lastIndexOf('p#a') - 90, text.lastIndexOf('p#a') + 3)
  expect(row).toMatch(/✗\s+1\.20s\s+aborted\s+local\s+p#a/)
  // b is still aborting, below the row a left.
  expect(region(out)).toContain('aborting')
  expect(region(out)).toContain('p#b')

  log.runEnd?.()
  log.runDone?.()
  log.status('footer')
  expect(out.text().endsWith('footer\n')).toBe(true)
})
