// `refuseUnknownOptions`: a plugin factory's misspelt option is refused as
// core refuses an unknown config field. Bun strips a config's types, so
// `reapi({ endpont })` reached the factory, read as unset, and the plugin
// declined with no word (stream F).
import { expect, it } from 'bun:test'
import { refuseUnknownOptions } from '../src/index.js'

const refusal = (options: unknown): string => {
  try {
    refuseUnknownOptions('demo()', options, ['endpoint', 'timeoutMs'])
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a key the factory does not read is refused, with the nearest spelling', () => {
  expect(refusal({ endpont: 'x' })).toBe(
    'demo() has unknown option "endpont" (allowed: endpoint, timeoutMs) — did you mean endpoint?',
  )
  expect(refusal({ verbose: true })).toBe(
    'demo() has unknown option "verbose" (allowed: endpoint, timeoutMs)',
  )
})

it('options that are not an object are refused', () => {
  expect(refusal('grpc://x')).toBe('demo(): options must be an object')
  expect(refusal(null)).toBe('demo(): options must be an object')
  expect(refusal(['endpoint'])).toBe('demo(): options must be an object')
})

it('no options, and every known key, are taken', () => {
  expect(refusal(undefined)).toBe('taken')
  expect(refusal({})).toBe('taken')
  expect(refusal({ endpoint: 'x', timeoutMs: 5 })).toBe('taken')
})
