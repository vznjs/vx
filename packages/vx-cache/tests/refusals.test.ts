// A refusal of what a workspace wrote is a UserError, as refuseUnknownOptions'
// and vxHistory()'s are: a plain Error printed as an internal crash, with
// `vx: Error: …` and the plugin's stack.
import { expect, it } from 'bun:test'
import { resolveVxCacheConfig, vxCache } from '../src/index.js'

const NAMED = { issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }

const nameOf = (f: () => unknown): string => {
  try {
    f()
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`
  }
  return 'no refusal'
}

it('refuses a bad option as a UserError', () => {
  expect(nameOf(() => vxCache({ ...NAMED, repository: 'bad' }))).toBe(
    'UserError: vxCache(): repository must be org/name, got bad',
  )
  expect(nameOf(() => vxCache({ ...NAMED, issuer: 'x' }))).toStartWith(
    'UserError: vxCache(): issuer must be',
  )
  expect(nameOf(() => vxCache({ ...NAMED, timeoutMs: 0 }))).toStartWith(
    'UserError: vxCache() option "timeoutMs" must be',
  )
  expect(nameOf(() => resolveVxCacheConfig({ ...NAMED, url: 'c.example' }, {}))).toBe(
    'UserError: vxCache(): url must be http(s), got c.example',
  )
  expect(nameOf(() => resolveVxCacheConfig({ ...NAMED, url: 'https://c.example/v1' }, {}))).toBe(
    "UserError: vxCache(): url is the server's base, without /v1: https://c.example",
  )
  expect(
    nameOf(() =>
      resolveVxCacheConfig({ ...NAMED, url: 'https://c.example', headers: { 'a b': 'x' } }, {}),
    ),
  ).toBe('UserError: vxCache() option "headers" cannot set "a b"')
  expect(
    nameOf(() =>
      resolveVxCacheConfig({ ...NAMED, url: 'https://c.example', headers: { a: 'x\ny' } }, {}),
    ),
  ).toBe(
    'UserError: vxCache() option "headers.a" must be one line of text (its value is not printed)',
  )
})
