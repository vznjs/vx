// A header no request can carry was refused only when a run built its
// layer, so with no URL set (a laptop, VX_CACHE_URL unset) it was never
// said, and the first CI run that named a server failed on it. It is
// refused where the workspace declares it, as a bad timeout is.
import { expect, it } from 'bun:test'
import { vxCache } from '../src/index.js'

const NAMED = { issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }

it('refuses a header no request can carry at the factory', () => {
  expect(() => vxCache({ ...NAMED, headers: { authorization: 'x' } })).toThrow(
    'vxCache(): headers cannot set "authorization"',
  )
  expect(() => vxCache({ ...NAMED, headers: { a: 'x\ny' } })).toThrow(
    'vxCache(): header "a" must be one line of text',
  )
  expect(() => vxCache({ ...NAMED, headers: { a: undefined, b: 'ok' } })).not.toThrow()
})
