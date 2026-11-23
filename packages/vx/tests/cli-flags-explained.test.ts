// M 2026-11-23 18:46 UTC: "Every field from all config should be
// documented and explained", and the docs redo's "as much show as
// possible". The CLI is config typed at the prompt, so it is held the
// same way: every verb has its own `## \`vx <verb>\`` section in
// docs/cli.md (the site splits each into a /cli/<verb>/ page), every flag
// the verb accepts has an entry there that explains it, and every section
// shows the verb's real coloured output in an `ansi` block.
//
// An entry is a heading that names the flag (`### \`--affected[=<base>]\``)
// or a table row whose first cell names it and whose last cell says
// something. cli-verb-sections.test.ts only asks that a flag be named.
// `vx pipeline` and `vx watch` take `vx run`'s flags, explained in run's
// Flags table; they need entries only for flags of their own.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { verbFlags } from '../src/cli/completions.js'
import { CORE_VERBS } from '../src/util/index.js'

const CLI_MD = readFileSync(path.join(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')

const INHERITS: Record<string, string> = { pipeline: 'run', watch: 'run' }

/** What a verb prints is a script for the shell, not for a person to read. */
const NO_OUTPUT_TO_SHOW = new Set(['completions'])

function section(verb: string): string | undefined {
  return CLI_MD.split(/^## /m).find(
    (p) => p.startsWith(`\`vx ${verb}\``) || p.startsWith(`\`vx ${verb} `),
  )
}

/** The section with its fenced blocks taken out: a sample is not an entry. */
const prose = (text: string): string => text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')

function explained(text: string, flag: string): boolean {
  const name = new RegExp(`\`${flag}(?![\\w-])`)
  return prose(text)
    .split('\n')
    .some((line) => {
      if (/^#{3,4} /.test(line)) return name.test(line)
      if (!line.startsWith('|')) return false
      const cells = line.split(/(?<!\\)\|/).slice(1, -1)
      return cells.length >= 2 && name.test(cells[0]!) && /\w/.test(cells.at(-1)!)
    })
}

const ESC = String.fromCharCode(27)
const ansiBlocks = (text: string): string[] =>
  [...text.matchAll(/^```ansi\n([\s\S]*?)^```/gm)].map((m) => m[1]!)

it('reads an entry from a heading or an explaining row, never a sample', () => {
  expect(explained('### `--affected[=<base>]`\n', '--affected')).toBe(true)
  expect(explained('| `--limit N` | how many sections |\n', '--limit')).toBe(true)
  expect(explained('| `--limit N` |  |\n', '--limit')).toBe(false)
  expect(explained('| `--limits` | more |\n', '--limit')).toBe(false)
  expect(explained('```sh\n| `--limit` | x |\n```\n', '--limit')).toBe(false)
  expect(explained('pass `--limit` to it\n', '--limit')).toBe(false)
})

it('every verb has its own section in docs/cli.md', () => {
  expect(CORE_VERBS.filter((v) => section(v) === undefined)).toEqual([])
})

it('every flag of every verb has an entry that explains it', () => {
  const missing: string[] = []
  for (const verb of CORE_VERBS) {
    const inherited = new Set(INHERITS[verb] === undefined ? [] : verbFlags(INHERITS[verb]))
    for (const flag of verbFlags(verb)) {
      if (flag === '--help' || inherited.has(flag)) continue
      if (!explained(section(verb) ?? '', flag)) missing.push(`vx ${verb} ${flag}`)
    }
  }
  expect(missing).toEqual([])
})

it("every verb's section shows its real coloured output", () => {
  const plain = CORE_VERBS.filter(
    (v) =>
      !NO_OUTPUT_TO_SHOW.has(v) && !ansiBlocks(section(v) ?? '').some((b) => b.includes(`${ESC}[`)),
  )
  expect(plain).toEqual([])
})
