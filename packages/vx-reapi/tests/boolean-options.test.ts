// `reapi({ execute: process.env.X })` passes the string 'true', which failed
// the `=== true` test: remote execution stayed off with no word (stream F).
import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'

const said = (execute: unknown): string => {
  try {
    reapi({ execute } as never)
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('execute that is not a boolean is refused', () => {
  expect(said('true')).toBe('reapi() option "execute" must be a boolean, got "true"')
  expect(said(1)).toBe('reapi() option "execute" must be a boolean, got 1')
})

it('a boolean, or none, is taken', () => {
  expect(said(true)).toBe('taken')
  expect(said(false)).toBe('taken')
  expect(said(undefined)).toBe('taken')
})
