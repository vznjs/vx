// `vx help` and cli.md's flag table said a bare --affected falls back
// from origin/HEAD straight to HEAD~1; #2122 put the trunk branches in
// between. Both name each trunk now, read from the list affected.ts
// tries.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { helpText } from '../src/cli/help.js'

const ROOT = path.resolve(import.meta.dir, '..')
const trunks = (): string[] => {
  const src = readFileSync(path.join(ROOT, 'src', 'workspace', 'affected.ts'), 'utf8')
  const list = JSON.parse(
    /const TRUNKS = (\[[^\]]*\])/.exec(src)![1]!.replaceAll("'", '"'),
  ) as string[]
  return [...new Set(list.map((t) => t.replace(/^origin\//, '')))]
}

describe('the --affected default names the trunk fallback', () => {
  it('in vx help and in the cli.md flag table', () => {
    const text = helpText()
    const help = text.slice(text.indexOf('--affected[=<base>]')).split('\n').slice(0, 3).join(' ')
    const row = readFileSync(path.join(ROOT, 'docs', 'cli.md'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('| `--affected[=<base>]`') && l.includes('(default '))!
    const missing = (text: string): string[] =>
      [...trunks(), 'HEAD~1'].filter((t) => !new RegExp(`\\b${t.replace('~', '\\~')}`).test(text))
    expect({ help: missing(help), row: missing(row) }).toEqual({ help: [], row: [] })
  })
})
