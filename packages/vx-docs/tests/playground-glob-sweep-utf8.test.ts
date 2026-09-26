// Item 834: the glob port's multibyte rows, apart from
// playground-glob-sweep.test.ts because a backtrack bounded by the path
// (the mutation those rows hold) loops forever on these.
import { describe, expect, it } from 'bun:test'
import { Glob } from '../src/playground/shim/glob.js'

const rows: Array<[pattern: string, path: string, bun: boolean]> = [
  // A star's backtrack resumes one CHARACTER on, not one byte: into the
  // middle of `😀` the classes after it would read a continuation byte.
  ['**[^b][^b]', '😀', false],
  ['**[!a][^b][^b]', 'ÿ😀', false],
  // Control.
  ['**[^b]', '😀', true],
]

describe('the playground glob port on multibyte paths, past the fuzz', () => {
  for (const [pattern, path, bun] of rows) {
    it(`${JSON.stringify(pattern)} against ${JSON.stringify(path)} is ${bun}`, () => {
      expect(new Bun.Glob(pattern).match(path)).toBe(bun)
      expect(new Glob(pattern).match(path)).toBe(bun)
    })
  }
})
