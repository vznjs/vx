// Two wildcard alphabets, one question each (item 577). `GLOB_WILDCARDS`
// decides whether a DECLARATION must be matched rather than compared as a
// string, and counts the brace (item 495: `dist/{a,b}.txt` read as a literal
// let two tasks delete each other's outputs). `MOUNT_WILDCARDS` decides
// whether a GRANT is scanned for matches or mounted as the path it names,
// and does NOT count the brace: `write: ['g/{a,b}.txt']` is a literal to the
// sandbox, gets a placeholder and is widened to its directory, which works;
// scanned, it matches nothing before the task writes and the grant is lost.
// Item 667 took the brackets out of `GLOB_WILDCARDS` (a bracket is literal in
// a task glob) and kept `Bun.Glob`'s own set as `BUN_GLOB_WILDCARDS`, which is
// what the grant set is one brace short of.
// Nine inline spellings of these two sets used to sit across src/; the last
// row holds them to their two homes.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isMountableLiteral, MOUNT_WILDCARDS } from '../src/exec/index.js'
import { BUN_GLOB_WILDCARDS, GLOB_WILDCARDS, isLiteralPattern } from '../src/util/index.js'

const ALPHABET: Array<[string, string, { glob: boolean; mount: boolean }]> = [
  ['star', 'g/*.txt', { glob: false, mount: false }],
  ['question mark', 'g/a?.txt', { glob: false, mount: false }],
  // A bracket is literal in a task glob (item 667), still a class to a grant.
  ['class open', 'g/[ab].txt', { glob: true, mount: false }],
  ['class close', 'g/ab].txt', { glob: true, mount: false }],
  ['brace open', 'g/{a,b}.txt', { glob: false, mount: true }],
  ['brace close', 'g/a}.txt', { glob: false, mount: true }],
  ['CONTROL plain path', 'g/a.txt', { glob: true, mount: true }],
  ['CONTROL dotted, dashed', './g-1/a.b.txt', { glob: true, mount: true }],
]

describe('isLiteralPattern and isMountableLiteral, member by member', () => {
  for (const [what, p, want] of ALPHABET) {
    it(`${what}: ${p}`, () => {
      expect({ p, glob: isLiteralPattern(p), mount: isMountableLiteral(p) }).toEqual({ p, ...want })
    })
  }

  it('the brace is the whole difference between a grant and Bun.Glob', () => {
    // Differential for the smaller set: with `{}` added to MOUNT_WILDCARDS
    // the two brace rows above go red, and nothing else moves.
    expect(BUN_GLOB_WILDCARDS.source).toBe(`${MOUNT_WILDCARDS.source.slice(0, -1)}{}]`)
    // …and the brackets are the whole difference between Bun.Glob and a task glob.
    expect(BUN_GLOB_WILDCARDS.source).toBe(GLOB_WILDCARDS.source.replace('?', '?[\\]'))
  })
})

describe('the two alphabets have one spelling each in src/', () => {
  it('no inline `[*?[` character class outside their homes', () => {
    const SRC = path.resolve(import.meta.dir, '..', 'src')
    const homes = new Set(['util/paths.ts', 'exec/sandbox-paths.ts'])
    const found: string[] = []
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC })) {
      const file = rel.split(path.sep).join('/')
      if (homes.has(file)) continue
      const code = readFileSync(path.join(SRC, rel), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      for (const l of code) if (/\[\*\?\[/.test(l)) found.push(`${file}: ${l.trim()}`)
    }
    // `wholeSubtreePrefixes` (util/paths.ts) matches a whole-pattern SHAPE
    // and is in a home; nothing else may spell the class.
    expect(found).toEqual([])
  })
})
