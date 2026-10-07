import { afterEach, expect, it } from 'bun:test'
import { benchEnv } from '../bench-env.js'

const saved = process.env['BUN_OPTIONS']
afterEach(() => {
  if (saved === undefined) delete process.env['BUN_OPTIONS']
  else process.env['BUN_OPTIONS'] = saved
})

it('drops BUN_OPTIONS and keeps the rest, extras included', () => {
  process.env['BUN_OPTIONS'] = '--smol'
  const env = benchEnv({ NO_COLOR: '1' })
  expect(env['BUN_OPTIONS']).toBeUndefined()
  expect(env['NO_COLOR']).toBe('1')
  expect(env['PATH']).toBe(process.env['PATH'])
})

it('a child spawned with it sees no BUN_OPTIONS', () => {
  process.env['BUN_OPTIONS'] = '--smol'
  const p = Bun.spawnSync({
    cmd: ['sh', '-c', 'printf %s "${BUN_OPTIONS-unset}"'],
    env: benchEnv(),
  })
  expect(p.stdout.toString()).toBe('unset')
})

it("keeps vx's whole cache in the workspace, where a wipe makes the next run cold", () => {
  expect(benchEnv()['VX_CACHE_DIR']).toBe('.vx/cache')
})
