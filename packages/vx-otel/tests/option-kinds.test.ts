// A number where a string belongs (`otel({ endpoint: 4318 })`) threw
// `v.trim is not a function` out of the plugin; it is refused naming the
// option and its kind (stream F).
import { expect, it } from 'bun:test'
import { otel } from '../src/index.js'

it('an option of the wrong kind is refused at the factory', () => {
  expect(() => otel({ endpoint: 4318 } as never)).toThrow(
    new Error('otel() option "endpoint" must be a string, got 4318'),
  )
  expect(() => otel({ timeoutMs: '5000' } as never)).toThrow(
    new Error('otel() option "timeoutMs" must be a number, got "5000"'),
  )
})
