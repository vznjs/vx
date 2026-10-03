// Exit codes are a 1.0 contract, and CI scripts branch on them. The
// exit-code records drive each documented outcome and cli-verb-sections
// holds each verb's section to them; neither sees a code the source can
// return that no record drives. This holds the whole set both ways: the
// codes core's CLI can produce (each verb's `return N`, bin.ts's own, and
// 128 + n for each signal a run stops on) are the codes cli.md's exit-code
// statements name, no more, no fewer. A plugin verb's code is its own
// (cli.md § Plugin commands) and is left out on both sides.
import { constants } from 'node:os'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8')

function sourceCodes(): number[] {
  const codes = new Set<number>()
  // plugin-templates.ts is the text of a plugin `vx init --plugin` writes.
  const verbs = readdirSync(path.join(SRC, 'cli')).filter(
    (f) => f.endsWith('.ts') && f !== 'plugin-templates.ts',
  )
  for (const f of verbs)
    for (const m of read(`cli/${f}`).matchAll(/\breturn (\d{1,3})\b/g)) codes.add(Number(m[1]))
  for (const m of read('bin.ts').matchAll(/exitCode = (\d{1,3})\b/g)) codes.add(Number(m[1]))
  const stop = /export type StopSignal = ([^\n]+)/.exec(read('orchestrator/signals.ts'))![1]!
  for (const m of stop.matchAll(/'(SIG[A-Z]+)'/g))
    codes.add(128 + constants.signals[m[1] as keyof typeof constants.signals])
  return [...codes].sort((a, b) => a - b)
}

function documentedCodes(): number[] {
  const doc = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
  const codes = new Set<number>()
  for (const part of doc.split(/^## /m)) {
    if (part.startsWith('Plugin commands')) continue
    const at = part.search(/[Ee]xit codes?:|^#+ Exit codes$/m)
    if (at === -1) continue
    // The statement: from "Exit codes" to the next blank line after its
    // list or table (a table or list runs until a blank line follows it).
    const rest = part.slice(at)
    const end = rest.search(/\n\n(?![|-] |\s+[|-])/)
    for (const m of rest.slice(0, end === -1 ? undefined : end + 1).matchAll(/`(\d{1,3})`/g))
      codes.add(Number(m[1]))
  }
  return [...codes].sort((a, b) => a - b)
}

describe("cli.md's exit codes are the ones the CLI can return", () => {
  it('reads codes from returns, bin.ts and the stop signals', () => {
    expect(sourceCodes()).toContain(130)
    expect(sourceCodes()).toContain(143)
  })

  it('names every code the CLI can return, and no other', () => {
    expect(documentedCodes()).toEqual(sourceCodes())
  })
})
