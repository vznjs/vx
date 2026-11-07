// A buffered frame of a 100 MB log peaked vx at ~1.2 GB: an object and a
// string per line, the frame joined into one string (two bytes a
// character once its corners are in it), copied again by each template
// around it, and encoded whole by the stream. A big frame is now written
// in pieces, each at most 1 Mi characters, with the same bytes as before.
import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { formatTaskBlock } from '../src/report/framed-output.js'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/ui/live-region.js'

const SLICE = 1024 * 1024

function pipe(): StatusStream & { chunks: string[] } {
  const chunks: string[] = []
  return {
    isTTY: false,
    chunks,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
  }
}

const node = {
  id: 'p#t',
  projectName: 'p',
  taskName: 't',
  requested: true,
  deps: [],
  config: { exec: { command: 'true' } },
} as unknown as TaskNode

const COLORS = { enabled: true, level: 3 } as const
const line = 'abcdefghijklmnopqrstuvwxyz0123456789 ✓\n'
const output = [
  { text: line.repeat(40_000), err: false },
  { text: 'half a line, then stderr: ', err: false },
  { text: `rest\n${'err line\n'.repeat(20_000)}`, err: true },
  { text: line.repeat(40_000), err: false },
]

for (const [name, gha] of [
  ['a pipe', false],
  ['GitHub Actions', true],
] as const) {
  it(`a big frame is written in pieces, the same bytes (${name})`, () => {
    const out = pipe()
    const log = defaultLogger(COLORS, { mode: 'full', ...(gha ? { gha } : {}) }, out, {
      forceFloorMs: 0,
      coalesce: true,
    })
    log.runStart?.({ total: 1 })
    log.taskStart?.(node)
    for (const c of output) (c.err ? log.taskStderr : log.taskStdout)(node, c.text)
    const outcome = { node, status: 'success', exitCode: 0, durationMs: 1 } as TaskOutcome
    log.taskComplete(node, outcome)
    log.settle()
    const block = formatTaskBlock(node, outcome, { output }, COLORS)
    expect(block.length).toBeGreaterThan(2 * SLICE)
    const text = out.chunks.join('')
    if (gha) {
      const m = /^\n::group::p#t \(success [^)]*\)\n::stop-commands::([0-9a-f-]{36})\n/.exec(text)
      expect(m).not.toBeNull()
      expect(text.slice(m![0].length)).toBe(`${block}::${m![1]}::\n::endgroup::\n\n`)
    } else expect(text).toBe(`\n${block}\n`)
    expect(Math.max(...out.chunks.map((c) => c.length))).toBeLessThanOrEqual(SLICE)
  })
}

it('the output section renders a line by the stream that began it', () => {
  const lines = formatTaskBlock(
    node,
    { node, status: 'success', exitCode: 0, durationMs: 1 } as TaskOutcome,
    {
      output: [
        { text: 'o1\no2', err: false },
        { text: '+e\ne1\ne2', err: true },
        { text: '+o\no3\n', err: false },
      ],
    },
    COLORS,
  ).split('\n')
  const red = (s: string) => lines.some((l) => l.includes(s) && l.includes('\x1b['))
  expect(lines).toContain('o1')
  expect(lines).toContain('o2+e')
  expect(red('e1')).toBe(true)
  expect(red('e2+o')).toBe(true)
  expect(lines).toContain('o3')
})
