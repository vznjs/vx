// A timeout that is not a positive number of ms armed the abort at once
// (Bun sets a NaN, zero, negative or over-2³¹−1 delay to 1 ms), and every
// request failed as it started. Each is refused, naming the option, as
// otel() refuses its timeoutMs.
import { expect, it } from 'bun:test'
import { resolveVxCacheConfig, vxCache } from '../src/index.js'

const NAMED = { issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }

it('refuses a timeout that is not a positive number of ms a timer can hold', () => {
  for (const name of ['timeoutMs', 'uploadTimeoutMs'] as const)
    for (const [bad, shown] of [
      [Number.NaN, 'NaN'],
      [0, '0'],
      [-5, '-5'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [2 ** 31, '2147483648'],
    ] as const) {
      const said = `vxCache(): ${name} must be a positive number of ms up to 2147483647, got ${shown}`
      expect(() => vxCache({ ...NAMED, [name]: bad })).toThrow(said)
      expect(() =>
        resolveVxCacheConfig({ ...NAMED, url: 'https://c.example', [name]: bad }, {}),
      ).toThrow(said)
    }
})

it('takes a positive timeout, or the default', () => {
  const c = resolveVxCacheConfig(
    { ...NAMED, url: 'https://c.example', timeoutMs: 1000, uploadTimeoutMs: 2 ** 31 - 1 },
    {},
  )
  expect([c?.timeoutMs, c?.uploadTimeoutMs]).toEqual([1000, 2 ** 31 - 1])
  const d = resolveVxCacheConfig({ ...NAMED, url: 'https://c.example' }, {})
  expect([d?.timeoutMs, d?.uploadTimeoutMs]).toEqual([30_000, 60_000])
})
