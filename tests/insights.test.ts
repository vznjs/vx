import { describe, expect, it } from 'bun:test'
import { parseInsightsArgs } from '../src/cli/index.js'

describe('vx insights parser', () => {
  it('defaults to port 5290', () => {
    const r = parseInsightsArgs([])
    expect(r.port).toBe(5290)
    expect(r.error).toBeUndefined()
  })

  it('accepts --port <n>', () => {
    expect(parseInsightsArgs(['--port', '6000']).port).toBe(6000)
  })

  it('accepts --port=<n>', () => {
    expect(parseInsightsArgs(['--port=6001']).port).toBe(6001)
  })

  it('rejects non-numeric port', () => {
    const r = parseInsightsArgs(['--port', 'oops'])
    expect(r.error).toMatch(/invalid --port/)
  })

  it('rejects out-of-range port', () => {
    expect(parseInsightsArgs(['--port', '0']).error).toMatch(/invalid --port/)
    expect(parseInsightsArgs(['--port', '99999']).error).toMatch(/invalid --port/)
  })

  it('rejects unknown flags', () => {
    expect(parseInsightsArgs(['--nope']).error).toMatch(/unknown flag/)
  })
})
