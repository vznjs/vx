// `vx init` under Yarn 1 printed `next: yarn dlx @vzn/vx …`, and Yarn 1
// has no `dlx` (`Command "dlx" not found`). Berry keeps `yarn dlx`.
import { describe, expect, it } from 'bun:test'
import { vxInvocation } from '../src/workspace/migration.js'

describe('vxInvocation — Yarn 1 has no dlx', () => {
  it('names npx for Yarn 1 when vx is not installed, yarn otherwise', () => {
    expect(
      [
        ['yarn/1.22.22 npm/? node/v22.22.2 linux x64', false],
        ['yarn/1.22.22 npm/? node/v22.22.2 linux x64', true],
        ['yarn/4.5.0 npm/? node/v22.22.2 linux x64', false],
        ['yarn/4.5.0 npm/? node/v22.22.2 linux x64', true],
      ].map(([ua, installed]) => vxInvocation(ua as string, installed as boolean)),
    ).toEqual(['npx @vzn/vx', 'yarn vx', 'yarn dlx @vzn/vx', 'yarn vx'])
  })
})
