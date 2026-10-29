// Every core verb names the nearest word it takes when it refuses one.
// `vx upgrade --hlp` and `vx help --hlp` said "unknown" with no hint,
// `vx completions bsh` named no shell, and `vx version --hlp` printed
// the version and exited 0: `flagHint` knew a verb's flags from its
// usage line, where no verb spells `--help`.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CORE_VERBS } from '../src/cli/help.js'
import { run } from './helpers/cli.js'

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
  mock.restore()
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

/** What a refusal prints (a thrown one: its message, as bin.ts reads it), and its exit code. */
async function refused(argv: string[]): Promise<[number, string]> {
  stderr = ''
  // `why` and `last` refuse by throwing, which bin.ts prints as-is.
  const code = await run(argv).catch((e: Error) => {
    stderr += `${e.message}\n`
    return 1
  })
  return [code, stderr]
}

const HLP: Record<string, string[]> = {
  run: ['run', 'build', '--hlp'],
  watch: ['watch', 'build', '--hlp'],
  cache: ['cache', 'clean', '--hlp'],
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
      // A thrown refusal is its message; a printed one, its notice.
      expect(line).toMatch(
        /unknown flag: --hlp \(did you mean --help\?\) \(see `vx |unknown flag: --hlp\n\n {2}see vx .*\n\n {2}fix {2}--help\n/,
      )
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
        '✗ vx completions  expected one shell — bash, zsh or fish (got bsh)\n\n  see vx completions --help\n\n  fix  bash\n',
      ],
      [
        1,
        '✗ vx completions  expected one shell — bash, zsh or fish (got powershell)\n\n  see vx completions --help\n',
      ],
      [
        1,
        '✗ vx completions  expected one shell — bash, zsh or fish (got tcsh)\n\n  see vx completions --help\n',
      ],
      [
        1,
        '✗ vx completions  expected one shell — bash, zsh or fish\n\n  see vx completions --help\n',
      ],
    ])
  })

  it('vx version takes no word, and with none still prints and exits 0', async () => {
    expect([await refused(['version', 'extra']), await refused(['--version', '-x'])]).toEqual([
      [1, '✗ vx version  unexpected argument: extra\n\n  see vx version --help\n'],
      [1, '✗ vx version  unknown flag: -x\n\n  see vx version --help\n'],
    ])
    expect(await run(['version'])).toBe(0)
    expect(await run(['--version'])).toBe(0)
  })

  // A flag exactly one other verb takes names that verb, not a near guess
  // here (`vx run --poll` has its own line, naming `vx watch --poll`).
  it("another verb's own flag names that verb, not a near one here", async () => {
    expect([await refused(['show', '--list']), await refused(['why', 'build', '--list'])]).toEqual([
      [1, '✗ vx show  unknown flag: --list\n\n  `vx last` takes it\n  see vx show --help\n'],
      [1, 'vx why: unknown flag: --list. `vx last` takes it (see `vx why --help`)\n'],
    ])
    // A flag two other verbs take names neither (control).
    expect(await refused(['show', '--global'])).toEqual([
      1,
      '✗ vx show  unknown flag: --global\n\n  see vx show --help\n',
    ])
  })

  // `vx lock --check=yes` named no flag: --check is no edit from itself.
  it('a value given to a bare flag names the bare flag', async () => {
    expect([
      await refused(['lock', '--check=yes']),
      await refused(['upgrade', '--global=true']),
    ]).toEqual([
      [1, '✗ vx lock  unknown flag: --check=yes\n\n  see vx lock --help\n\n  fix  --check\n'],
      [
        1,
        '✗ vx upgrade  unknown flag: --global=true\n\n  see vx upgrade --help\n\n  fix  --global\n',
      ],
    ])
  })

  it('vx help takes one verb: a second word is refused, not dropped', async () => {
    expect([
      await refused(['help', 'run', 'extra']),
      await refused(['help', 'run', '--hlp']),
    ]).toEqual([
      [1, '✗ vx help  unexpected argument: extra\n\n  see vx help\n'],
      [1, '✗ vx help  unknown flag: --hlp\n\n  see vx help\n\n  fix  --help\n'],
    ])
    expect(await run(['help', 'run'])).toBe(0)
  })

  it('a flag far from --help gets no hint (control)', async () => {
    expect(await refused(['lock', '--zzz'])).toEqual([
      1,
      '✗ vx lock  unknown flag: --zzz\n\n  see vx lock --help\n',
    ])
  })
})
