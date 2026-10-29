// A bad VX_CACHE_URL was refused as "url must be http(s)", naming an
// option the workspace never set. The refusal names where the URL came
// from.
import { expect, it } from 'bun:test'
import { resolveVxCacheConfig } from '../src/index.js'

const NAMED = { issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }

it('names VX_CACHE_URL when the URL came from it', () => {
  expect(() => resolveVxCacheConfig(NAMED, { VX_CACHE_URL: 'c.example' })).toThrow(
    'vxCache(): VX_CACHE_URL must be https (http only to 127.0.0.1, ::1 or localhost), got c.example',
  )
  expect(() => resolveVxCacheConfig(NAMED, { VX_CACHE_URL: 'https://c.example/v1' })).toThrow(
    "vxCache(): VX_CACHE_URL is the server's base, without /v1: https://c.example",
  )
})

it('names the url option when the URL came from it', () => {
  expect(() =>
    resolveVxCacheConfig({ ...NAMED, url: 'c.example' }, { VX_CACHE_URL: 'https://e.example' }),
  ).toThrow(
    'vxCache(): url must be https (http only to 127.0.0.1, ::1 or localhost), got c.example',
  )
})
