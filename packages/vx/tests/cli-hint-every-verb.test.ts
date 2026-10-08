// Every core verb names the nearest word it takes when it refuses one.
// `vx upgrade --hlp` and `vx help --hlp` said "unknown" with no hint,
// `vx completions bsh` named no shell, and `vx version --hlp` printed
// the version and exited 0: `flagHint` knew a verb's flags from its
// usage line, where no verb spells `--help`.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CORE_VERBS } from '../src/cli/help.js'
import { run } from '../src/cli/index.js'

let stderr = ''
let cwd = ''
let dir = ''
beforeEach(async () => {
  stderr = ''
  spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
  spyOn(process.stdout, 'write').mockImplementation(() => true)
  cwd = process.cwd()
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hint-'))
  process.chdir(dir)
})
afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

/** The first line a refusal prints, and its exit code. */
async function refused(argv: string[]): Promise<[number, string]> {
  stderr = ''
  // `why` and `last` refuse by throwing, which bin.ts prints as-is.
  const code = await run(argv).catch((e: Error) => {
    stderr += `${e.message}\n`
    return 1
  })
  return [code, stderr.split('\n')[0]!]
}

const HLP: Record<string, string[]> = {
  run: ['run', 'build', '--hlp'],
  watch: ['watch', 'build', '--hlp'],
  cache: ['cache', 'prune', '--hlp'],
  why: ['why', 'build', '--hlp'],
}

describe('a refused word names the nearest one the verb takes', () => {
  it('covers every core verb', () => {
    expect(CORE_VERBS.length).toBeGreaterThan(12)
  })

  for (const verb of CORE_VERBS) {
    it(`vx ${verb} --hlp hints --help`, async () => {
      const [code, line] = await refused(HLP[verb] ?? [verb, '--hlp'])
      expect(code).toBe(1)
      expect(line).toContain(': unknown flag: --hlp (did you mean --help?) (see `vx ')
    })
  }

  it('a shell typo names the shell; a word near none (`tcsh` is no typo of bash), and two shells, name nothing', async () => {
    expect([
      await refused(['completions', 'bsh']),
      await refused(['completions', 'powershell']),
      await refused(['completions', 'tcsh']),
      await refused(['completions', 'zsh', 'fish']),
    ]).toEqual([
      [
        1,
        'vx completions: expected one shell — bash, zsh or fish (got bsh). Did you mean bash? (see `vx completions --help`)',
      ],
      [
        1,
        'vx completions: expected one shell — bash, zsh or fish (got powershell) (see `vx completions --help`)',
      ],
      [
        1,
        'vx completions: expected one shell — bash, zsh or fish (got tcsh) (see `vx completions --help`)',
      ],
      [1, 'vx completions: expected one shell — bash, zsh or fish (see `vx completions --help`)'],
    ])
  })

  it('vx version takes no word, and with none still prints and exits 0', async () => {
    expect([await refused(['version', 'extra']), await refused(['--version', '-x'])]).toEqual([
      [1, 'vx version: unexpected argument: extra (see `vx version --help`)'],
      [1, 'vx version: unknown flag: -x (see `vx version --help`)'],
    ])
    expect(await run(['version'])).toBe(0)
    expect(await run(['--version'])).toBe(0)
  })

  it('a flag far from --help gets no hint (control)', async () => {
    expect(await refused(['lock', '--json'])).toEqual([
      1,
      'vx lock: unknown flag: --json (see `vx lock --help`)',
    ])
  })
})
