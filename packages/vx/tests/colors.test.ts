import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { detectColors, paint } from '../src/util/colors.js'
import { restoreEnv } from './helpers/env.js'

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

  // The footer's projects bar painted its empty dim remainder when every
  // project was in the run: an escape pair around no cell.
  it('paints no escape pair around empty text', () => {
    expect(paint('#22c55e', '', { enabled: true }, { bold: true, dim: true })).toBe('')
  })
})

describe('detectColors', () => {
  const orig = { ...process.env }

  const CI_VARS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI']
  beforeEach(() => {
    delete process.env['NO_COLOR']
    delete process.env['FORCE_COLOR']
    for (const v of CI_VARS) delete process.env[v]
  })

  afterEach(() => {
    restoreEnv(orig)
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

  // GitHub Actions and GitLab render ANSI in a piped log, which read plain (2026-10-22).
  it('paints a piped log on a CI that renders colour, unless NO_COLOR or FORCE_COLOR=0', () => {
    const piped = { isTTY: false } as NodeJS.WriteStream
    expect(
      CI_VARS.map((v) => {
        for (const c of CI_VARS) delete process.env[c]
        process.env[v] = 'true'
        return detectColors(piped).enabled
      }),
    ).toEqual([true, true, true, true])
    process.env['FORCE_COLOR'] = '0'
    expect(detectColors(piped).enabled).toBe(false)
    delete process.env['FORCE_COLOR']
    process.env['NO_COLOR'] = '1'
    expect(detectColors(piped).enabled).toBe(false)
  })

  it('falls through to stream.isTTY when neither env var is set', () => {
    expect(detectColors({ isTTY: true } as NodeJS.WriteStream).enabled).toBe(true)
    expect(detectColors({ isTTY: false } as NodeJS.WriteStream).enabled).toBe(false)
  })

  // nx#35292: any non-empty FORCE_COLOR turned colour ON, so `FORCE_COLOR=0`
  // — the convention's "off" (supports-color, chalk, Node) — wrote escapes
  // into a piped CI log. `0` and `false` are off, even on a TTY; any other
  // value, the empty string included, is on; unset leaves it to the TTY.
  it('FORCE_COLOR: 0 and false are off, any other value is on, unset is the TTY', () => {
    const decide = (value: string | undefined, isTTY: boolean): boolean => {
      if (value === undefined) delete process.env['FORCE_COLOR']
      else process.env['FORCE_COLOR'] = value
      return detectColors({ isTTY } as NodeJS.WriteStream).enabled
    }
    const values = ['0', 'false', '1', 'true', '', undefined] as const
    const table = values.map((v) => [v ?? '(unset)', decide(v, true), decide(v, false)])
    expect(table).toEqual([
      // FORCE_COLOR, on a TTY, piped
      ['0', false, false],
      ['false', false, false],
      ['1', true, true],
      ['true', true, true],
      ['', true, true],
      ['(unset)', true, false],
    ])
  })

  it('a non-empty NO_COLOR wins over every FORCE_COLOR; an empty one is no opinion', () => {
    const decide = (noColor: string, force: string | undefined, isTTY: boolean): boolean => {
      process.env['NO_COLOR'] = noColor
      if (force === undefined) delete process.env['FORCE_COLOR']
      else process.env['FORCE_COLOR'] = force
      return detectColors({ isTTY } as NodeJS.WriteStream).enabled
    }
    const forces = ['0', '1', '', undefined] as const
    expect(
      forces.map((f) => [f ?? '(unset)', decide('1', f, true), decide('1', f, false)]),
    ).toEqual([
      ['0', false, false],
      ['1', false, false],
      ['', false, false],
      ['(unset)', false, false],
    ])
    expect(forces.map((f) => [f ?? '(unset)', decide('', f, true), decide('', f, false)])).toEqual([
      ['0', false, false],
      ['1', true, true],
      ['', true, true],
      ['(unset)', true, false],
    ])
  })
})
