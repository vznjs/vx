// Item 834's sweep of the playground's glob port (src/playground/shim/glob.ts):
// pairs the fuzz in playground-glob.test.ts does not reach, each pinning
// Bun's own answer beside the port's. A file of its own: three of the
// mutations these hold make the port loop forever on the fuzz's pairs, and
// a synchronous loop cannot be bounded inside a row, so these rows must be
// the ones that fail cleanly.
import { describe, expect, it } from 'bun:test'
import { Glob } from '../src/playground/shim/glob.js'

const rows: Array<[pattern: string, path: string, bun: boolean]> = [
  // A star's backtrack resumes one CHARACTER on, not one byte: into the
  // middle of `😀` the classes after it would read a continuation byte.
  ['**[^b][^b]', '😀', false],
  ['**[!a][^b][^b]', 'ÿ😀', false],
  // The globstar is a copy of the wildcard, not the same object; and a
  // backtrack only ever resumes inside the path.
  ['**/*', '{/', false],
  ['**/', '}[', false],
  // Controls.
  ['**[^b]', '😀', true],
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
