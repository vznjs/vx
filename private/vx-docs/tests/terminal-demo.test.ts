import { describe, expect, it } from 'bun:test'
import { normalize } from '../scripts/terminal-demo.ts'

const DIM = (s: string): string => `<tspan opacity="0.55">${s}</tspan>`
const timeRow = (parts: string[]): string =>
  `<text x="18" y="310">  ${DIM('time    ')}  53ms${parts.map((p) => ` ${DIM('·')} ${DIM(p)}`).join('')}</text>`

describe('terminal-demo --check', () => {
  // The footer drops a spread value equal to one already on the row
  // (summary.ts), so which of max/avg/min print is itself a timing.
  it('ignores which spread values a run printed', () => {
    const all = timeRow(['max 9ms', 'avg 6ms', 'min 4ms'])
    expect(normalize(timeRow(['max 9ms', 'min 4ms']))).toBe(normalize(all))
    expect(normalize(timeRow([]))).toBe(normalize(all))
  })

  // A row's distance from its usual time is a timing: its sign, and so
  // its colour (dim within a fifth, red slower, green faster), vary by run.
  it('ignores how far a row ran from its usual time, sign and colour', () => {
    const row = (delta: string): string => `<text x="18" y="40">  8ms ${delta} success</text>`
    expect(normalize(row(DIM('+1ms')))).toBe(normalize(row(DIM('\u22127ms'))))
    expect(normalize(row('<tspan fill="rgb(239,68,68)">+12ms</tspan>'))).toBe(
      normalize(row(DIM('\u22121ms'))),
    )
    expect(normalize(row('unknown'))).not.toBe(normalize(row(DIM('+1ms'))))
  })

  it('still sees a changed word', () => {
    expect(normalize(timeRow(['max 9ms']).replace('time', 'took'))).not.toBe(
      normalize(timeRow(['max 9ms'])),
    )
  })
})
