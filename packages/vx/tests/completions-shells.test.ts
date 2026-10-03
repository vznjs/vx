// The completion scripts loaded in the shells themselves. bash is driven
// in completions.test.ts; here zsh loads its script both ways a user does:
// autoloaded from $fpath, as `vx completions zsh > ~/.zfunc/_vx` sets up,
// and sourced. Autoloaded, the first Tab defined `_vx` and completed
// nothing (the bell); the second worked. fish answers `complete -C`.
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

/**
 * What zsh's completion builtins receive when `_vx` runs with `words`, the
 * script loaded as `how`. `compadd` and `compdef` are stubbed with shell
 * functions, which zsh runs before a builtin of the same name, so this
 * needs no terminal: an interactive zsh under zpty answered nothing inside
 * the macOS sandbox, its control row included.
 */
async function zshCalls(
  how: 'autoload' | 'source',
  words: string[],
  tag: string,
): Promise<string[]> {
  const fn = path.join(dir, tag)
  await Bun.write(path.join(fn, '_vx'), completionScript('zsh', [...CORE_VERBS]))
  const driver = path.join(dir, `${tag}.zsh`)
  await writeFile(
    driver,
    [
      'compadd() { print -r -- "compadd $*" }',
      'compdef() { print -r -- "compdef $*" }',
      how === 'autoload'
        ? [
            `fpath=(${fn} $fpath)`,
            'autoload -Uz _vx',
            `words=(${words.join(' ')})`,
            `CURRENT=${words.length}`,
            '_vx',
          ].join('\n')
        : `source ${path.join(fn, '_vx')}`,
    ].join('\n'),
  )
  const p = Bun.spawnSync({ cmd: [ZSH!, '-f', driver], timeout: 20_000 })
  return p.stdout.toString().trim().split('\n')
}

describe.skipIf(ZSH === null)('zsh', () => {
  it('autoloaded from $fpath, the first call completes a verb and a flag', async () => {
    const verb = await zshCalls('autoload', ['vx', 'ca'], 'auto-verb')
    const flag = await zshCalls('autoload', ['vx', 'run', '--conc'], 'auto-flag')
    expect([verb.length, verb[0]!.startsWith('compadd -- run watch cache')]).toEqual([1, true])
    expect([flag.length, flag[0]!.split(' ').includes('--concurrency')]).toEqual([1, true])
  })

  it('sourced, it registers itself (control)', async () => {
    expect(await zshCalls('source', [], 'sourced')).toEqual(['compdef _vx vx'])
  })
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
