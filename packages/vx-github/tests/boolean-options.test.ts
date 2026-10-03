// `github({ checks: process.env.X })` passes a string: 'false' is not
// `false`, so the check run was still posted, and 'true' is not `true`, so a
// missing environment was skipped rather than warned (stream F).
import { expect, it } from 'bun:test'
import { github } from '../src/index.js'

const said = (checks: unknown): string => {
  try {
    github({ checks } as never)
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('checks that is not a boolean is refused', () => {
  expect(said('false')).toBe('vx-github: checks must be true or false, got "false"')
})

it('a boolean, or none, is taken', () => {
  expect(said(false)).toBe('taken')
  expect(said(true)).toBe('taken')
  expect(said(undefined)).toBe('taken')
})
