import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunArgs, run } from './cli.js'

describe('cli run()', () => {
  let stdout: string
  let stderr: string

  beforeEach(() => {
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints help with no args', async () => {
    expect(await run([])).toBe(0)
    expect(stdout).toContain('Usage:')
  })

  it('prints version', async () => {
    expect(await run(['--version'])).toBe(0)
    expect(stdout).toMatch(/^vzn \d/)
  })

  it('rejects unknown command', async () => {
    expect(await run(['nope'])).toBe(1)
    expect(stderr).toContain('unknown command')
  })

  it('rejects run with no task', async () => {
    expect(await run(['run'])).toBe(1)
    expect(stderr).toContain('missing task name')
  })
})

describe('parseRunArgs', () => {
  it('parses task name', () => {
    const r = parseRunArgs(['build'])
    expect(r.task).toBe('build')
    expect(r.projects).toEqual([])
    expect(r.force).toBe(false)
  })

  it('parses repeated --project', () => {
    const r = parseRunArgs(['build', '-p', 'a', '--project', 'b'])
    expect(r.task).toBe('build')
    expect(r.projects).toEqual(['a', 'b'])
  })

  it('parses --concurrency', () => {
    expect(parseRunArgs(['build', '-c', '4']).concurrency).toBe(4)
    expect(parseRunArgs(['build', '--concurrency', '2']).concurrency).toBe(2)
  })

  it('parses --force', () => {
    expect(parseRunArgs(['build', '--force']).force).toBe(true)
    expect(parseRunArgs(['build', '-f']).force).toBe(true)
  })

  it('rejects unknown flag', () => {
    expect(parseRunArgs(['--bogus']).error).toMatch(/unknown flag/)
  })

  it('rejects missing flag value', () => {
    expect(parseRunArgs(['build', '-p']).error).toMatch(/requires a value/)
  })

  it('rejects bad concurrency', () => {
    expect(parseRunArgs(['build', '-c', 'abc']).error).toMatch(/invalid concurrency/)
  })

  it('rejects double positional', () => {
    expect(parseRunArgs(['a', 'b']).error).toMatch(/unexpected positional/)
  })
})
