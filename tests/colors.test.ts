import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { detectColors, paint } from '../src/orchestrator/colors.js'

describe('paint', () => {
  it('returns the bare text when colors are disabled', () => {
    expect(paint('red', 'hello', { enabled: false })).toBe('hello')
  })

  it('wraps text with a truecolor escape + reset when enabled', () => {
    const out = paint('red', 'hello', { enabled: true })
    expect(out.startsWith('\x1b[')).toBe(true)
    expect(out.endsWith('\x1b[0m')).toBe(true)
    expect(out).toContain('hello')
    // ansi-16m truecolor sequence — we don't pin the exact RGB
    // (Bun.color may resolve named colors slightly differently across
    // versions), but the shape is fixed.
    // Match just the truecolor part of the sequence — the leading
    // ESC is implied. Avoids embedding U+001B in a regex literal,
    // which oxlint flags via no-control-regex.
    expect(out).toMatch(/\[38;2;\d+;\d+;\d+m/)
  })

  it('layers bold and dim with the color', () => {
    const out = paint('green', 'x', { enabled: true }, { bold: true, dim: true })
    expect(out).toContain('\x1b[1m')
    expect(out).toContain('\x1b[2m')
  })

  it('emits bold/dim alone when no color is given', () => {
    const out = paint('', 'x', { enabled: true }, { bold: true })
    expect(out).toBe('\x1b[1mx\x1b[0m')
  })

  it('returns plain text when no color and no formatting are given even if enabled', () => {
    expect(paint('', 'plain', { enabled: true })).toBe('plain')
  })
})

describe('detectColors', () => {
  const orig = { ...process.env }

  beforeEach(() => {
    delete process.env['NO_COLOR']
    delete process.env['FORCE_COLOR']
  })

  afterEach(() => {
    process.env = { ...orig }
  })

  it('NO_COLOR forces off, even with FORCE_COLOR also set', () => {
    process.env['NO_COLOR'] = '1'
    process.env['FORCE_COLOR'] = '1'
    expect(detectColors({ isTTY: true } as NodeJS.WriteStream).enabled).toBe(false)
  })

  it('FORCE_COLOR forces on for non-TTY streams', () => {
    process.env['FORCE_COLOR'] = '1'
    expect(detectColors({ isTTY: false } as NodeJS.WriteStream).enabled).toBe(true)
  })

  it('falls through to stream.isTTY when neither env var is set', () => {
    expect(detectColors({ isTTY: true } as NodeJS.WriteStream).enabled).toBe(true)
    expect(detectColors({ isTTY: false } as NodeJS.WriteStream).enabled).toBe(false)
  })
})
