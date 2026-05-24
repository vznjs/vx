import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'
import { loadConfigs } from './load.ts'

function ws(dirs: { name: string; dir: string }[]) {
  return { workspace: { projects: dirs } }
}

describe('loadConfigs', () => {
  it('returns an empty list when no project has a vx.config', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
    })
    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))
    expect(result).toEqual([])
  })

  it('loads a vx.config.ts and validates the base schema', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': `
        export default {
          tasks: {
            build: { description: 'compile', exec: { command: 'bun run b' } },
            test: { exec: { command: 'bun test' }, dependsOn: ['build'] },
          },
        }
      `,
    })

    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))

    expect(result).toHaveLength(1)
    expect(result[0]!.project.name).toBe('a')
    expect(result[0]!.config.tasks).toEqual({
      build: { description: 'compile', exec: { command: 'bun run b' } },
      test: { exec: { command: 'bun test' }, dependsOn: ['build'] },
    })
  })

  it('accepts the defineProject helper', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': `
        import { defineProject } from '${import.meta.dir.replace(/\\/g, '/')}/index.ts'
        export default defineProject({
          tasks: { lint: { exec: { command: 'oxlint' } } },
        })
      `,
    })

    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))

    expect(result[0]!.config.tasks).toEqual({ lint: { exec: { command: 'oxlint' } } })
  })

  it('accepts an empty tasks object', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: {} }',
    })

    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))

    expect(result[0]!.config.tasks).toEqual({})
  })

  it('accepts a config with no tasks field at all', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default {}',
    })

    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))

    expect(result[0]!.config).toEqual({})
  })

  it('preserves unknown fields untouched for extension modules', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': `
        export default {
          tasks: {
            build: {
              exec: { command: 'b' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist'] } },
            },
          },
        }
      `,
    })

    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))
    const build = result[0]!.config.tasks!.build as Record<string, unknown>

    expect(build.cache).toEqual({
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist'] },
    })
  })

  it('loads configs in parallel across projects', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { x: { exec: { command: "a" } } } }',
      'pkg/b/package.json': '{"name":"b"}',
      'pkg/b/vx.config.ts': 'export default { tasks: { x: { exec: { command: "b" } } } }',
    })

    const result = await loadConfigs(
      ws([
        { name: 'a', dir: join(root, 'pkg/a') },
        { name: 'b', dir: join(root, 'pkg/b') },
      ]),
    )

    expect(result.map((c) => c.project.name).sort()).toEqual(['a', 'b'])
  })

  it('throws if the module has no default export', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export const tasks = {}',
    })

    await expect(loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))).rejects.toThrow(
      /default export/,
    )
  })

  it('throws if tasks is not an object', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: ["build"] }',
    })

    await expect(loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))).rejects.toThrow(
      /tasks.*object/i,
    )
  })

  it('throws if a task exec.command is not a string', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { build: { exec: { command: 42 } } } }',
    })

    await expect(loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))).rejects.toThrow(
      /exec.command.*string/i,
    )
  })

  it('throws if dependsOn is not an array of strings', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { build: { dependsOn: [42] } } }',
    })

    await expect(loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))).rejects.toThrow(
      /dependsOn/i,
    )
  })

  it('includes the project name in error messages', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/broken/package.json': '{"name":"broken"}',
      'pkg/broken/vx.config.ts': 'export default { tasks: { build: { dependsOn: 7 } } }',
    })

    await expect(
      loadConfigs(ws([{ name: 'broken', dir: join(root, 'pkg/broken') }])),
    ).rejects.toThrow(/broken/)
  })

  it('prefers vx.config.ts over .mts/.js/.mjs when multiple exist', async () => {
    const root = await makeWorkspaceAsync({
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { winner: { exec: { command: "ts" } } } }',
      'pkg/a/vx.config.mts': 'export default { tasks: { loser: { exec: { command: "mts" } } } }',
    })

    const result = await loadConfigs(ws([{ name: 'a', dir: join(root, 'pkg/a') }]))

    expect(Object.keys(result[0]!.config.tasks ?? {})).toEqual(['winner'])
  })
})
