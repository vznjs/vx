// `vx completions <shell>`: the verbs and every flag of each, from the same
// help text `vx <verb> --help` prints — one source, so a flag cannot be
// documented and not completed.

import { describe, expect, it } from 'bun:test'
import { completionScript, verbFlags } from '../src/cli/completions.js'
import { documentedFlags, CORE_VERBS } from '../src/cli/help.js'
import { run } from '../src/cli/index.js'

const VERBS = [...CORE_VERBS, 'mcp']

describe('verbFlags', () => {
  it('reads every documented run flag, and the flags of the other verbs, from the help cut', () => {
    const runFlags = verbFlags('run')
    for (const f of documentedFlags('run')) expect(runFlags).toContain(f)
    expect(verbFlags('cache')).toEqual(
      expect.arrayContaining(['--older-than', '--max-size', '--dry-run', '--cache-dir']),
    )
    expect(verbFlags('last')).toEqual(expect.arrayContaining(['--list', '--format', '--cache-dir']))
    expect(verbFlags('cache')).not.toContain('--concurrency')
    // Every verb completes --help.
    for (const v of CORE_VERBS) expect(verbFlags(v)).toContain('--help')
  })
})

describe('completionScript', () => {
  it('bash: names every verb and every run flag, and parses', async () => {
    const script = completionScript('bash', VERBS)
    for (const v of VERBS) expect(script).toContain(v)
    for (const f of documentedFlags('run')) expect(script).toContain(f)
    expect(script).toContain('complete -F _vx vx')
    const proc = Bun.spawn(['bash', '-n'], {
      stdin: new Blob([script]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
  })

  it('zsh and fish: names every verb and the run flags', () => {
    const zsh = completionScript('zsh', VERBS)
    expect(zsh.startsWith('#compdef vx')).toBe(true)
    const fish = completionScript('fish', VERBS)
    expect(fish).toContain('complete -c vx')
    for (const v of VERBS) {
      expect(zsh).toContain(v)
      expect(fish).toContain(`-a ${v}`)
    }
    for (const f of documentedFlags('run')) {
      expect(zsh).toContain(f)
      expect(fish).toContain(`-l ${f.slice(2)}`)
    }
  })
})

describe('vx completions (dispatch)', () => {
  it('prints the script for a known shell and refuses an unknown one, naming the three', async () => {
    let out = ''
    let err = ''
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      expect(await run(['completions', 'bash'])).toBe(0)
      expect(out).toContain('complete -F _vx vx')
      expect(await run(['completions', 'powershell'])).toBe(1)
      expect(err).toMatch(/bash, zsh or fish/)
      expect(await run(['completions'])).toBe(1)
    } finally {
      process.stdout.write = so
      process.stderr.write = se
    }
  })
})
