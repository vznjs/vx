import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { loadConfigs } from '../../src/config/load.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

describe('loadConfigs', () => {
  it('returns an empty list when no source has a vx.config file', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
    })

    const result = await loadConfigs([{ name: 'a', dir: join(root, 'pkg/a') }])

    expect(result).toEqual([])
  })

  it('loads an empty config', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/vx.config.ts': 'export default {}',
    })

    const result = await loadConfigs([{ name: 'a', dir: join(root, 'pkg/a') }])

    expect(result).toHaveLength(1)
    expect(result[0]!.source.name).toBe('a')
    expect(result[0]!.config).toEqual({})
  })

  it('returns whatever the user exported (no validation)', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/vx.config.ts': 'export default { tasks: { build: { command: "tsc" } }, anything: 7 }',
    })

    const result = await loadConfigs([{ name: 'a', dir: join(root, 'pkg/a') }])

    expect(result[0]!.config).toEqual({
      tasks: { build: { command: 'tsc' } },
      anything: 7,
    } as unknown as Record<string, unknown>)
  })

  it('loads in parallel across sources', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/vx.config.ts': 'export default { tag: "a" }',
      'pkg/b/vx.config.ts': 'export default { tag: "b" }',
    })

    const result = await loadConfigs([
      { name: 'a', dir: join(root, 'pkg/a') },
      { name: 'b', dir: join(root, 'pkg/b') },
    ])

    expect(result.map((c) => c.source.name).sort()).toEqual(['a', 'b'])
  })

  it('prefers vx.config.ts over .mts/.js/.mjs when multiple exist', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/vx.config.ts': 'export default { picked: "ts" }',
      'pkg/a/vx.config.mts': 'export default { picked: "mts" }',
      'pkg/a/vx.config.js': 'export default { picked: "js" }',
    })

    const result = await loadConfigs([{ name: 'a', dir: join(root, 'pkg/a') }])

    expect((result[0]!.config as unknown as { picked: string }).picked).toBe('ts')
  })
})
