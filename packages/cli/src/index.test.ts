import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './index.js'

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

  it('prints help with no args', () => {
    expect(run([])).toBe(0)
    expect(stdout).toContain('Usage: nxt')
  })

  it('prints version', () => {
    expect(run(['--version'])).toBe(0)
    expect(stdout).toMatch(/^nxt \d/)
  })

  it('rejects unknown command', () => {
    expect(run(['nope'])).toBe(1)
    expect(stderr).toContain('unknown command')
  })
})
