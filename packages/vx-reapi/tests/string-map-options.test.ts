// `headers` and `platform` are maps of strings, and a value read from an unset
// variable (`headers: { 'x-api-key': process.env.KEY! }`) is undefined. The
// printable-ASCII check read it as the text "undefined" and let it through:
// grpc-js then spun on every call until its deadline (15 s each, naming no
// option), and a platform value reached the worker as "undefined". Refused
// once an endpoint is set, naming the key. With none, the plugin declines:
// a laptop with neither variable set failed every vx command on a plugin
// "safe to leave declared".
import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'

const ctx = { warn: () => {}, workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache' } as never
const ENDPOINT = 'grpc://127.0.0.1:1'

it('a header value that is not a string is refused once an endpoint is set', () => {
  expect(() =>
    reapi({ endpoint: ENDPOINT, headers: { 'x-api-key': undefined as never } }).cache?.(ctx),
  ).toThrow(new Error('reapi() option "headers.x-api-key" must be a string, got undefined'))
  expect(() => reapi({ endpoint: ENDPOINT, headers: { 'x-n': 1 as never } }).cache?.(ctx)).toThrow(
    new Error('reapi() option "headers.x-n" must be a string, got number'),
  )
})

it('a platform value that is not a string is refused once an endpoint is set', () => {
  expect(() =>
    reapi({ endpoint: ENDPOINT, platform: { 'container-image': undefined as never } }).cache?.(ctx),
  ).toThrow(new Error('reapi() option "platform.container-image" must be a string, got undefined'))
})

it('with no endpoint, an unset value declines with the plugin', async () => {
  const p = reapi({
    headers: { 'x-api-key': undefined as never },
    platform: { 'container-image': undefined as never },
    execute: true,
  })
  expect(p.cache?.(ctx)).toBeUndefined()
  expect(await p.executor?.(ctx)).toBeUndefined()
})

it('string values pass (control)', () => {
  const p = reapi({ endpoint: ENDPOINT, headers: { a: 'b' }, platform: { OSFamily: 'linux' } })
  expect(p.cache?.(ctx)).toBeDefined()
  void p.teardown?.()
})
