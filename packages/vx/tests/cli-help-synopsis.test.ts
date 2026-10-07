// `vx <verb> --help` opens with the verb's usage line, and docs/cli.md's
// Top-level shape lists the same lines. The help line is what the parser
// accepts (`acceptedFlags` reads it); the doc line was held to the
// dispatcher by verb name only (cli-doc-drift), so a flag added to one
// and not the other passed. Each verb's usage lines are the synopsis's,
// word for word (a trailing `# comment` aside), and the verb's own help
// cut prints them.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CORE_VERBS, helpText, verbHelpText } from '../src/cli/help.js'

const DOC = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')

/** The Top-level shape block's lines for `verb`, comments dropped. */
function synopsis(verb: string, doc = DOC): string[] {
  const marker = '## Top-level shape\n\n```\n'
  const body = doc.slice(doc.indexOf(marker) + marker.length)
  return body
    .slice(0, body.indexOf('\n```\n'))
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l === `vx ${verb}` || l.startsWith(`vx ${verb} `))
}

/** The help Usage block's lines for `verb`. */
function usage(verb: string, text = helpText()): string[] {
  const block = text.split('\n\n').find((b) => b.startsWith('Usage:'))!
  return block
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l === `vx ${verb}` || l.startsWith(`vx ${verb} `))
}

describe("each verb's help usage is its cli.md synopsis", () => {
  it('reads a line by its verb, a comment dropped, a longer verb not matched', () => {
    const doc = '## Top-level shape\n\n```\n# Core\nvx up [tag]   # note\nvx upgrade x\n```\n'
    expect(synopsis('up', doc)).toEqual(['vx up [tag]'])
    expect(usage('up', 'title\n\nUsage:\n  vx up [tag]\n  vx upgrade x\n\nMore')).toEqual([
      'vx up [tag]',
    ])
  })

  for (const verb of CORE_VERBS) {
    it(`vx ${verb}`, () => {
      const lines = usage(verb)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines).toEqual(synopsis(verb))
      const own = verbHelpText(verb)
        .split('\n')
        .map((l) => l.trim())
      for (const line of lines) expect(own).toContain(line)
    })
  }
})

// A flag on a verb's usage line is a promise its own help explains it:
// `vx init --help` listed `--mjs` and said nothing of what it does.
describe("each usage flag is explained in the verb's own help", () => {
  for (const verb of CORE_VERBS) {
    it(`vx ${verb}`, () => {
      const prose = verbHelpText(verb)
        .split('\n\n')
        .filter((b) => !b.startsWith('Usage:'))
        .join('\n')
      const flags = usage(verb).flatMap((l) => l.match(/--[a-zA-Z][a-zA-Z-]*/g) ?? [])
      const unexplained = flags.filter((f) => !new RegExp(`${f}(?![a-zA-Z-])`).test(prose))
      expect(unexplained).toEqual([])
    })
  }
})
