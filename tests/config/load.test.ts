import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

describe('loadConfig', () => {
  it('loads an empty config', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export default {}',
    })

    const config = await loadConfig(join(root, 'vx.config.ts'))

    expect(config).toEqual({})
  })

  it('returns whatever the user exported (no validation)', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export default { whatever: 7, nested: { x: "y" } }',
    })

    const config = await loadConfig(join(root, 'vx.config.ts'))

    expect(config).toEqual({ whatever: 7, nested: { x: 'y' } } as unknown as Record<
      string,
      unknown
    >)
  })
})
