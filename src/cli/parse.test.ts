import { describe, expect, it } from 'bun:test'
import { parseArgs } from './parse.ts'

describe('parseArgs', () => {
  it('returns no command when argv is empty', () => {
    expect(parseArgs([])).toEqual({ command: null, positional: [], flags: {} })
  })

  it('parses a bare command', () => {
    expect(parseArgs(['graph'])).toEqual({ command: 'graph', positional: [], flags: {} })
  })

  it('parses positional args after a command', () => {
    expect(parseArgs(['graph', 'build', 'test'])).toEqual({
      command: 'graph',
      positional: ['build', 'test'],
      flags: {},
    })
  })

  it('parses long-form boolean flags', () => {
    expect(parseArgs(['graph', '--json'])).toEqual({
      command: 'graph',
      positional: [],
      flags: { json: true },
    })
  })

  it('parses --key=value', () => {
    expect(parseArgs(['graph', '--format=dot'])).toEqual({
      command: 'graph',
      positional: [],
      flags: { format: 'dot' },
    })
  })

  it('keeps positional order independent of flag placement', () => {
    expect(parseArgs(['graph', '--json', 'build', '--dot', 'test'])).toEqual({
      command: 'graph',
      positional: ['build', 'test'],
      flags: { json: true, dot: true },
    })
  })

  it('parses -- as a hard stop, capturing the rest as positional', () => {
    expect(parseArgs(['graph', 'build', '--', '--not-a-flag', 'x'])).toEqual({
      command: 'graph',
      positional: ['build', '--not-a-flag', 'x'],
      flags: {},
    })
  })

  it('parses --help globally', () => {
    expect(parseArgs(['--help'])).toEqual({
      command: null,
      positional: [],
      flags: { help: true },
    })
  })

  it('parses --version globally', () => {
    expect(parseArgs(['--version'])).toEqual({
      command: null,
      positional: [],
      flags: { version: true },
    })
  })
})
