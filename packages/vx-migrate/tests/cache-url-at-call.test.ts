// turboCache() and nxCache() checked a `url` option only in the `cache`
// hook, so a verb that opens no cache (`vx show`) took a url every run
// then failed on. vxCache() and vxHistory() refuse theirs at the call.
import { expect, it } from 'bun:test'
import { nxCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig, turboCache } from '../src/turbo-cache/index.js'

const said = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('refuses a url option at the call, as vxCache() and vxHistory() do', () => {
  expect([
    said(() => nxCache({ url: 'cache.example.com' })),
    said(() => nxCache({ url: 'https://u:p@c.example' })),
    said(() => turboCache({ url: 'cache.example.com' })),
    said(() => turboCache({ url: 'https://u:p@c.example' })),
    said(() => nxCache({ url: 'https://c.example' })),
    said(() => turboCache({ url: 'https://c.example' })),
  ]).toEqual([
    'nxCache() option "url" must be an http(s) URL, got "cache.example.com"',
    'nxCache() option "url" carries credentials (user:pass@); pass them as the token instead',
    'turboCache() option "url" must be an http(s) URL, got "cache.example.com"',
    'turboCache() option "url" carries credentials (user:pass@); pass them as the token instead',
    'taken',
    'taken',
  ])
})

// A trailing blank kept the slash before it, so each route went to
// `https://c.example/ /v8/…`; a leading one was refused as no http(s) URL
// (hardening, 2026-11-23). Refused as vxCache() refuses one.
it('refuses a url with blanks around it, from an option or the environment', () => {
  expect([
    said(() => nxCache({ url: 'https://c.example/ ' })),
    said(() =>
      resolveNxCacheConfig({}, { NX_SELF_HOSTED_REMOTE_CACHE_SERVER: ' https://c.example' }),
    ),
    said(() => turboCache({ url: 'https://c.example\n' })),
    said(() => resolveTurboCacheConfig({ token: 't' }, { TURBO_API: 'https://c.example/ ' })),
  ]).toEqual([
    'nxCache() option "url" has blanks around it: "https://c.example/ "',
    'NX_SELF_HOSTED_REMOTE_CACHE_SERVER has blanks around it: " https://c.example"',
    'turboCache() option "url" has blanks around it: "https://c.example\\n"',
    'TURBO_API has blanks around it: "https://c.example/ "',
  ])
})
