// The completion scripts loaded in the shells themselves. bash is driven
// in completions.test.ts; here zsh completes a line in an interactive
// shell (zpty), both ways a user loads it: autoloaded from $fpath, as
// `vx completions zsh > ~/.zfunc/_vx` sets up, and sourced. Autoloaded,
// the first Tab defined `_vx` and completed nothing (the bell); the
// second worked. fish answers `complete -C` for verbs and flags.
//
// A shell that is not installed skips its row, except zsh on macOS, where
// it always is: a missing one there is a failure, not a pass.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { completionScript } from '../src/cli/completions.js'
import { CORE_VERBS } from '../src/cli/help.js'

const ZSH = Bun.which('zsh')
const FISH = Bun.which('fish')
if (process.platform === 'darwin' && ZSH === null) throw new Error('macOS without zsh')

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-shells-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The line zsh holds after `typed` and a Tab, with `setup` run first. */
async function zshLine(setup: string, typed: string, tag: string): Promise<string> {
  const out = path.join(dir, `${tag}.out`)
  const driver = path.join(dir, `${tag}.zsh`)
  await writeFile(
    driver,
    [
      'zmodload zsh/zpty',
      "zpty z 'zsh -f -i'",
      // Sent inside the driver's double quotes, so its `$` are escaped to
      // reach the inner shell. The terminal echoes this line, so neither
      // marker may appear in it
      // as typed: `READ""Y` prints READY, `vx''p> ` is the prompt vxp>.
      `zpty -w z ${JSON.stringify(`PROMPT='vx''p> '; ${setup}; show() { print -r -- "BUF[$BUFFER]" > ${out} }; zle -N show; bindkey '^X' show; echo READ""Y`).replace(/\$/g, '\\$')}`,
      "zpty -r z x '*READY*'",
      // Keys typed before the line editor is up are discarded.
      "zpty -r z x '*vxp> *'",
      `zpty -w -n z $'${typed}\\t\\x18'`,
      `for i in {1..200}; do [[ -s ${out} ]] && break; sleep 0.05; done`,
      'zpty -d z',
      `cat ${out}`,
    ].join('\n'),
  )
  const p = Bun.spawnSync({ cmd: [ZSH!, '-f', driver], timeout: 20_000 })
  return p.stdout.toString().trim()
}

describe.skipIf(ZSH === null)('zsh', () => {
  let fpathDir = ''
  let sourced = ''
  beforeAll(async () => {
    fpathDir = path.join(dir, 'zfunc')
    await Bun.write(path.join(fpathDir, '_vx'), completionScript('zsh', [...CORE_VERBS]))
    sourced = path.join(dir, 'vx.zsh')
    await writeFile(sourced, completionScript('zsh', [...CORE_VERBS]))
  })

  it('autoloaded from $fpath, the first Tab completes a verb and a flag', async () => {
    const setup = `fpath=(${fpathDir} $fpath); autoload -U compinit; compinit -u -D`
    expect([
      await zshLine(setup, 'vx ca', 'fpath-verb'),
      await zshLine(setup, 'vx run --conc', 'fpath-flag'),
    ]).toEqual(['BUF[vx cache ]', 'BUF[vx run --concurrency ]'])
  }, 60_000)

  it('sourced, it completes the same (control)', async () => {
    const setup = `autoload -U compinit; compinit -u -D; source ${sourced}`
    expect(await zshLine(setup, 'vx ca', 'sourced-verb')).toBe('BUF[vx cache ]')
  }, 60_000)
})

describe.skipIf(FISH === null)('fish', () => {
  it('completes a verb, a flag and a subcommand', async () => {
    const script = path.join(dir, 'vx.fish')
    await writeFile(script, completionScript('fish', [...CORE_VERBS]))
    const ask = (line: string): string[] =>
      Bun.spawnSync({ cmd: [FISH!, '-c', `source ${script}; complete -C '${line}'`] })
        .stdout.toString()
        .split('\n')
        .map((l) => l.split('\t')[0]!)
        .filter(Boolean)
    expect([ask('vx ca'), ask('vx run --conc'), ask('vx cache ')]).toEqual([
      ['cache'],
      ['--concurrency'],
      ['prune'],
    ])
  })
})
