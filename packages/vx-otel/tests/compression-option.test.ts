// `otel({ compression: 'zstd' })` passed the kind check (a string) and
// warned on every run that it sent uncompressed, while a bad `timeoutMs`
// or a wrong kind is refused where the workspace declares it. The option
// is refused at the factory; the variables still warn, as the spec asks.
import { expect, it } from 'bun:test'
import { otel } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a compression that is not gzip or none is refused at the factory', () => {
  expect(refusal(() => otel({ compression: 'zstd' } as never))).toBe(
    `otel() option "compression" must be 'gzip' or 'none', got "zstd"`,
  )
  expect(refusal(() => otel({ compression: 'GZIP' } as never))).toBe(
    `otel() option "compression" must be 'gzip' or 'none', got "GZIP"`,
  )
})

it('gzip, none or no compression is taken', () => {
  expect(refusal(() => otel({ compression: 'gzip' }))).toBe('taken')
  expect(refusal(() => otel({ compression: 'none' }))).toBe('taken')
  expect(refusal(() => otel({}))).toBe('taken')
})
