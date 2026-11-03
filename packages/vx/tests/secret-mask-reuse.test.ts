// Every task of a run asks for the mask of the same values: built once,
// not a sort and a RegExp per task (2026-11-03). Values are read each call.

import { expect, it } from 'bun:test'
import { secretMask } from '../src/util/index.js'

it('the same values reuse one mask; a changed value builds its own', () => {
  const env: Record<string, string> = { API_TOKEN: 'tok-111111', DB_URL: 'pg://u:pw-222222@db/x' }
  const first = secretMask([env])
  expect(secretMask([{ ...env }])).toBe(first)
  env['API_TOKEN'] = 'tok-333333'
  const changed = secretMask([env])
  expect(changed).not.toBe(first)
  expect(changed?.mask('tok-111111 tok-333333 pw-222222')).toBe('tok-111111 *** ***')
})
