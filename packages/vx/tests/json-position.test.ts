// `jsonErrorAt`: where a refused package.json stops parsing.

import { describe, expect, it } from 'bun:test'
import { jsonErrorAt } from '../src/util/index.js'

describe('jsonErrorAt', () => {
  it('names the line and column of the first error', () => {
    expect(
      [
        '{"name":',
        '{\n  "name": "x",\n  "v": oops\n}',
        '{"a": 1,}',
        '{"a": 1} x',
        '{"a": "\u0001"}',
        '{"a": [1 2]}',
        '{\n  // c\n  "a": 1\n}',
        '{"a": 01}',
      ].map((t) => jsonErrorAt(t)),
    ).toEqual(['1:9', '3:8', '1:9', '1:10', '1:8', '1:10', '2:3', '1:8'])
  })

  it('takes comments and trailing commas as JSONC', () => {
    expect(jsonErrorAt('{\n  // c\n  "a": [1, 2,], /* d */\n}', true)).toBeUndefined()
    expect(jsonErrorAt('{ /* open', true)).toBe('1:3')
  })

  it('finds none in valid JSON', () => {
    for (const t of [
      '{}',
      '[]',
      '"s"',
      '-1.5e+3',
      ' {"a": {"b": [true, false, null, "\\u00e9\\n"]}} ',
    ])
      expect(jsonErrorAt(t)).toBeUndefined()
  })
})
