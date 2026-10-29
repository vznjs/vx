// Yarn 2+ removed `yarn global` ("The 'yarn global' commands have been
// removed in 2.x"), so `yarn dlx @vzn/vx init` failed at its first step,
// the global install. Under Berry it is Bun's, as with no runner.

import { describe, expect, it } from 'bun:test'
import { initInstalls } from '../src/cli/init.js'

describe('the global install vx init runs', () => {
  it('is Bun under Yarn 2+, and yarn global add under Yarn 1', () => {
    expect(
      initInstalls('1.2.3', 'yarn/4.5.0 npm/? node/v22.0.0 linux x64', null, undefined),
    ).toEqual([{ argv: ['bun', 'add', '-g', '@vzn/vx@1.2.3'], cwd: null }])
    expect(
      initInstalls('1.2.3', 'yarn/1.22.22 npm/? node/v22.0.0 linux x64', null, undefined),
    ).toEqual([{ argv: ['yarn', 'global', 'add', '@vzn/vx@1.2.3'], cwd: null }])
  })
})
