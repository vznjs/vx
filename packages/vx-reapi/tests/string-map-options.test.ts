// `headers` and `platform` are maps of strings, and a value read from an unset
// variable (`headers: { 'x-api-key': process.env.KEY! }`) is undefined. The
// printable-ASCII check read it as the text "undefined" and let it through:
// grpc-js then spun on every call until its deadline (15 s each, naming no
// option), and a platform value reached the worker as "undefined". Refused
// at the factory, naming the key, as an option of the wrong kind is.
import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'

it('a header value that is not a string is refused at the factory', () => {
  expect(() => reapi({ headers: { 'x-api-key': undefined as never } })).toThrow(
    new Error('reapi() option "headers.x-api-key" must be a string, got undefined'),
  )
  expect(() => reapi({ headers: { 'x-n': 1 as never } })).toThrow(
    new Error('reapi() option "headers.x-n" must be a string, got number'),
  )
})

it('a platform value that is not a string is refused at the factory', () => {
  expect(() => reapi({ platform: { 'container-image': undefined as never } })).toThrow(
    new Error('reapi() option "platform.container-image" must be a string, got undefined'),
  )
})

it('string values pass (control)', () => {
  expect(() => reapi({ headers: { a: 'b' }, platform: { OSFamily: 'linux' } })).not.toThrow()
})
