// `vx help` and cli.md's flag table say what a bare --affected compares
// with: the merge base with `origin/<baseBranch>`, and nothing on that
// branch (owner, 2026-10-17). They said `HEAD~1` after the rule was gone.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { helpText } from '../src/cli/help.js'

const ROOT = path.resolve(import.meta.dir, '..')

describe('the --affected default names the base branch', () => {
  it('in vx help and in the cli.md flag table', () => {
    const text = helpText()
    const help = text.slice(text.indexOf('--affected[=<base>]')).split('\n').slice(0, 3).join(' ')
    const row = readFileSync(path.join(ROOT, 'docs', 'cli.md'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('| `--affected[=<base>]`') && l.includes('(default '))!
    const says = (text: string) => ({
      branch: text.includes('origin/<baseBranch>'),
      none: /none on (that|the base) branch/.test(text),
      guess: text.includes('HEAD~1'),
    })
    const want = { branch: true, none: true, guess: false }
    expect({ help: says(help), row: says(row) }).toEqual({ help: want, row: want })
  })
})
