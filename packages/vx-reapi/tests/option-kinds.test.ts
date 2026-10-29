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

// An unset variable (`platform: { 'container-image': process.env.IMAGE }`)
// sent the property with an empty value on every action.
it('a platform or header value that is no string is refused at the factory', () => {
  expect(() => reapi({ platform: { 'container-image': undefined } } as never)).toThrow(
    new Error('reapi() option "platform.container-image" must be a string, got undefined'),
  )
  // A header's value is never printed: it is often a token.
  expect(() => reapi({ headers: { authorization: 5 } } as never)).toThrow(
    new Error('reapi() option "headers.authorization" must be a string, got number'),
  )
  expect(() => reapi({ platform: { OSFamily: 'linux' }, headers: { a: 'b' } })).not.toThrow()
})
