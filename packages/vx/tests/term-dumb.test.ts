// `TERM=dumb` (Emacs `M-x shell`, some CI log viewers) cannot move the
// cursor or paint. On such a terminal vx drew its live region with cursor-up
// and erase escapes and painted every row, so the log filled with escape
// junk (bug hunt round 3, 2026-10-15). It now prints as off a terminal;
// FORCE_COLOR still paints, as supports-color and chalk read it.
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { createOutputWriter, type StatusStream } from '../src/report/status-line.js'
import { detectColors } from '../src/util/colors.js'
import { restoreEnv } from './helpers/env.js'

const orig = { ...process.env }
beforeEach(() => {
  delete process.env['NO_COLOR']
  delete process.env['FORCE_COLOR']
  process.env['TERM'] = 'dumb'
})
afterEach(() => {
  restoreEnv(orig)
})

function tty(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: true,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

it('a dumb terminal gets no colour, unless FORCE_COLOR asks', () => {
  expect(detectColors({ isTTY: true } as NodeJS.WriteStream).enabled).toBe(false)
  process.env['FORCE_COLOR'] = '1'
  expect(detectColors({ isTTY: true } as NodeJS.WriteStream).enabled).toBe(true)
})

it('a dumb terminal gets no live region: writes pass through with no escape', () => {
  const s = tty()
  const w = createOutputWriter(s, { forceFloorMs: 0 })
  expect(w.enabled).toBe(false)
  w.setStatus('▶ 1 running', { force: true })
  w.write('hello\n')
  w.clearStatus()
  expect(s.text()).toBe('hello\n')
})

it('CONTROL: another TERM keeps the live region', () => {
  process.env['TERM'] = 'xterm-256color'
  expect(detectColors({ isTTY: true } as NodeJS.WriteStream).enabled).toBe(true)
  expect(createOutputWriter(tty()).enabled).toBe(true)
})
