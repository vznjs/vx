// Item 834's sweep of the playground's glob port (src/playground/shim/glob.ts):
// pairs the fuzz in playground-glob.test.ts does not reach, each pinning
// Bun's own answer beside the port's. Files of their own: some of the
// mutations these hold make the port loop forever on other pairs, and a
// synchronous loop cannot be bounded inside a row, so each mutation needs a
// file whose rows fail on it without looping (the multibyte rows are
// playground-glob-sweep-utf8.test.ts for that reason).
import { describe, expect, it } from 'bun:test'
import { Glob } from '../src/playground/shim/glob.js'

const rows: Array<[pattern: string, path: string, bun: boolean]> = [
  // The globstar is a copy of the wildcard, not the same object; and a
  // backtrack only ever resumes inside the path.
  ['**/*', '{/', false],
  ['**/', '}[', false],
  // A branch's globstar reads back only to its own branch start.
  ['{**/,', '', true],
  ['{**/}', '', true],
  // `\\t` is a tab in Bun's escape table.
  ['\\t', '\t', true],
  // A dangling `\\` with path left to match is an invalid pattern: no match.
  ['a\\', 'ab', false],
  // Controls.
  ['**/*', '{/a', true],
]

describe('the playground glob port, past the fuzz', () => {
  for (const [pattern, path, bun] of rows) {
    it(`${JSON.stringify(pattern)} against ${JSON.stringify(path)} is ${bun}`, () => {
      expect(new Bun.Glob(pattern).match(path)).toBe(bun)
      expect(new Glob(pattern).match(path)).toBe(bun)
    })
  }
})
