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

  it('still sees a changed word', () => {
    expect(normalize(timeRow(['max 9ms']).replace('time', 'took'))).not.toBe(
      normalize(timeRow(['max 9ms'])),
    )
  })
})
