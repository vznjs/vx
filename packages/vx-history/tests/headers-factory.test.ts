// A header no request can carry was refused only when a run asked the
// history server, so with no URL set (a laptop, VX_HISTORY_URL unset) it
// was never said, and the first CI run that named a server failed on it.
// It is refused where the workspace declares it, as vxCache() refuses it.
import { expect, it } from 'bun:test'
import { vxHistory } from '../src/index.js'

const NAMED = { issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`
  }
}

it('refuses a header no request can carry at the factory', () => {
  expect(refusal(() => vxHistory({ ...NAMED, headers: { authorization: 'x' } }))).toBe(
    'UserError: vxHistory(): headers cannot set "authorization"',
  )
  expect(refusal(() => vxHistory({ headers: { a: 'x\ny' } }))).toBe(
    'UserError: vxHistory(): header "a" must be one line of text',
  )
  expect(refusal(() => vxHistory({ ...NAMED, headers: { a: undefined, b: 'ok' } }))).toBe('taken')
})
