// `otel({ timeoutMs: 0 })` was refused only when a run built its sink: with
// no endpoint set (a laptop) it was never said, and on CI the refusal
// skipped the sink as a telemetry failure. It is refused where the
// workspace declares it, as vxCache() refuses its timeouts.
import { expect, it } from 'bun:test'
import { otel } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`
  }
}

it('a timeout that is not a positive number is refused at the factory', () => {
  expect(refusal(() => otel({ timeoutMs: 0 }))).toBe(
    'UserError: [vx-otel] timeoutMs must be a positive number of ms, got 0',
  )
  expect(refusal(() => otel({ timeoutMs: Number.NaN }))).toBe(
    'UserError: [vx-otel] timeoutMs must be a positive number of ms, got null',
  )
  expect(refusal(() => otel({ timeoutMs: 1000 }))).toBe('taken')
})
