// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `github()` now refuse a key it does not read (stream F).
import { expect, it } from 'bun:test'
import { github } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => github({ titel: 'x' } as never))).toBe(
    'github() has unknown option "titel" (allowed: append, cacheScope, checkName, checks, fetchFn, sizeOf, summaryFile, title) \u2014 did you mean title?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => github({}))).not.toContain('unknown option')
})
