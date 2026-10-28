// A number where a string belongs (`reapi({ endpoint: 443 })`) threw
// `….trim is not a function` out of the cache hook; it is refused at the
// factory naming the option and its kind (stream F).
import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'

it('an option of the wrong kind is refused at the factory', () => {
  expect(() => reapi({ endpoint: 443 } as never)).toThrow(
    new Error('reapi() option "endpoint" must be a string, got 443'),
  )
  expect(() => reapi({ platform: 'linux' } as never)).toThrow(
    new Error('reapi() option "platform" must be an object, got "linux"'),
  )
})

// A capacity of 0 or 1.5 was taken, and with `execute` refused only once
// the server answered, by core, naming the executor and not the option.
it('a capacity that is no whole number above 0 is refused at the factory', () => {
  for (const capacity of [0, -1, 1.5, Number.NaN, Infinity])
    expect(() => reapi({ capacity })).toThrow(
      new Error(
        `reapi() option "capacity" must be a whole number above 0, got ${String(capacity)}`,
      ),
    )
  expect(() => reapi({ capacity: 4 })).not.toThrow()
})
