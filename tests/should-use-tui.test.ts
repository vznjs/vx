// Decision-table tests for the TUI fall-back predicate. Order of
// checks matters: first match wins. See docs/design/tui-design.md §5.

import { describe, expect, it } from 'bun:test'
import { shouldUseTui, type TuiEnv } from '../src/tui/should-use-tui.ts'

const base = (): TuiEnv => ({
  argv: {},
  stdinIsTTY: true,
  stdoutIsTTY: true,
  noColor: false,
  ci: false,
  customLogger: false,
  customObserver: false,
  columns: 120,
  rows: 30,
})

describe('shouldUseTui — disqualifiers (first-match wins)', () => {
  it('--no-tui beats every other check', () => {
    const env = base()
    env.argv.noTui = true
    env.argv.tui = true // even with --tui explicit
    expect(shouldUseTui(env)).toEqual({ use: false, reason: '--no-tui' })
  })

  it('planning modes (dry / graph) disqualify before TTY checks', () => {
    expect(shouldUseTui({ ...base(), argv: { dry: true } })).toEqual({
      use: false,
      reason: 'planning mode',
    })
    expect(shouldUseTui({ ...base(), argv: { graph: true } })).toEqual({
      use: false,
      reason: 'planning mode',
    })
  })

  it('non-TTY stdout disqualifies', () => {
    expect(shouldUseTui({ ...base(), stdoutIsTTY: false })).toEqual({
      use: false,
      reason: 'stdout is not a TTY',
    })
  })

  it('non-TTY stdin disqualifies (interactive keys impossible)', () => {
    expect(shouldUseTui({ ...base(), stdinIsTTY: false })).toEqual({
      use: false,
      reason: 'stdin is not a TTY',
    })
  })

  it('NO_COLOR disqualifies', () => {
    expect(shouldUseTui({ ...base(), noColor: true })).toEqual({
      use: false,
      reason: 'NO_COLOR set',
    })
  })

  it('CI environment disqualifies', () => {
    expect(shouldUseTui({ ...base(), ci: true })).toEqual({
      use: false,
      reason: 'CI environment',
    })
  })

  it('custom logger / observer disqualifies (embedder is consuming structurally)', () => {
    expect(shouldUseTui({ ...base(), customLogger: true })).toEqual({
      use: false,
      reason: 'custom logger configured',
    })
    expect(shouldUseTui({ ...base(), customObserver: true })).toEqual({
      use: false,
      reason: 'custom logger configured',
    })
  })

  it('terminal smaller than 80×20 disqualifies', () => {
    expect(shouldUseTui({ ...base(), columns: 79 })).toEqual({
      use: false,
      reason: 'terminal smaller than 80x20',
    })
    expect(shouldUseTui({ ...base(), rows: 19 })).toEqual({
      use: false,
      reason: 'terminal smaller than 80x20',
    })
    // Exact 80×20 — boundary inclusive; allow.
    expect(shouldUseTui({ ...base(), columns: 80, rows: 20, argv: { tui: true } })).toEqual({
      use: true,
    })
  })
})

describe('shouldUseTui — opt-in', () => {
  it('--tui activates when nothing disqualifies', () => {
    expect(shouldUseTui({ ...base(), argv: { tui: true } })).toEqual({ use: true })
  })

  it('default (no --tui) returns opt-in fail-through', () => {
    expect(shouldUseTui(base())).toEqual({ use: false, reason: 'opt-in' })
  })

  it('--tui + disqualifier returns the disqualifier reason (not opt-in)', () => {
    // Lets the CLI surface "TUI unavailable (<reason>)" when the user
    // explicitly asked.
    expect(shouldUseTui({ ...base(), argv: { tui: true }, ci: true })).toEqual({
      use: false,
      reason: 'CI environment',
    })
  })
})
