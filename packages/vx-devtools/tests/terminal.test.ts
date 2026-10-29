// A server's start and refusal line, painted as vx's status lines are.
import { afterEach, expect, it } from 'bun:test'
import { statusLine } from '../src/index.js'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

it('paints the symbol, the name and the URL when colour is forced', () => {
  process.env['FORCE_COLOR'] = '1'
  delete process.env['NO_COLOR']
  const line = statusLine('ok', 'vx-x', 'listening on http://127.0.0.1:1/', {})
  expect(line).toContain('\x1b[')
  expect(Bun.stripANSI(line)).toBe('✓ vx-x  listening on http://127.0.0.1:1/\n')
})

it('NO_COLOR wins over FORCE_COLOR, and a refusal keeps its usage lines', () => {
  process.env['FORCE_COLOR'] = '1'
  process.env['NO_COLOR'] = '1'
  expect(statusLine('err', 'vx-x', 'bad port\nusage: vx-x', { isTTY: true })).toBe(
    '✗ vx-x  bad port\nusage: vx-x\n',
  )
})
