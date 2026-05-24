import { describe, expect, it } from 'bun:test'
import type { LoadedConfig } from '../../src/config/types.ts'
import type { Workspace } from '../../src/workspace/types.ts'
import { buildInventory } from '../../src/inventory/build.ts'

function ws(root: string, projects: { name: string; dir: string }[]): Workspace {
  return { root, projects }
}

function loaded(
  name: string,
  dir: string,
  tasks: NonNullable<LoadedConfig['config']['tasks']>,
): LoadedConfig {
  return { project: { name, dir }, config: { tasks } }
}

describe('buildInventory', () => {
  it('returns workspace.root and an empty projects list for an empty workspace', () => {
    const inv = buildInventory({ workspace: ws('/ws', []), configs: [] })

    expect(inv).toEqual({ workspace: { root: '/ws' }, projects: [] })
  })

  it('emits one project entry per discovered project', () => {
    const workspace = ws('/ws', [
      { name: 'a', dir: '/ws/pkg/a' },
      { name: 'b', dir: '/ws/pkg/b' },
    ])
    const inv = buildInventory({ workspace, configs: [] })

    expect(inv.projects).toEqual([
      { name: 'a', dir: '/ws/pkg/a', targets: [] },
      { name: 'b', dir: '/ws/pkg/b', targets: [] },
    ])
  })

  it('emits the targets a project declared in vx.config order', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [
      loaded('a', '/ws/pkg/a', {
        build: { exec: { command: 'tsc' } },
        test: { exec: { command: 'bun test' } },
        lint: { exec: { command: 'oxlint' } },
      }),
    ]

    const inv = buildInventory({ workspace, configs })

    expect(inv.projects[0]!.targets.map((t) => t.name)).toEqual(['build', 'test', 'lint'])
  })

  it('includes description when present', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [
      loaded('a', '/ws/pkg/a', {
        build: { description: 'compile sources', exec: { command: 'tsc' } },
      }),
    ]

    const inv = buildInventory({ workspace, configs })

    expect(inv.projects[0]!.targets[0]).toEqual({
      name: 'build',
      description: 'compile sources',
      command: 'tsc',
    })
  })

  it('omits command for group tasks (no exec)', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [
      loaded('a', '/ws/pkg/a', {
        ci: { dependsOn: ['lint', 'test'] },
        lint: { exec: { command: 'oxlint' } },
        test: { exec: { command: 'bun test' } },
      }),
    ]

    const inv = buildInventory({ workspace, configs })

    const ci = inv.projects[0]!.targets.find((t) => t.name === 'ci')!
    expect(ci.command).toBeUndefined()
    expect(ci.dependsOn).toEqual(['lint', 'test'])
  })

  it('emits dependsOn raw — does not resolve ^name or pkg#name', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [
      loaded('a', '/ws/pkg/a', {
        build: { exec: { command: 'b' }, dependsOn: ['^build', 'compile', 'other#x'] },
        compile: { exec: { command: 'c' } },
      }),
    ]

    const inv = buildInventory({ workspace, configs })

    expect(inv.projects[0]!.targets[0]!.dependsOn).toEqual(['^build', 'compile', 'other#x'])
  })

  it('omits dependsOn when the task declared none', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [loaded('a', '/ws/pkg/a', { build: { exec: { command: 'b' } } })]

    const inv = buildInventory({ workspace, configs })

    expect(inv.projects[0]!.targets[0]).toEqual({ name: 'build', command: 'b' })
  })

  it('omits dependsOn when the array is empty', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [loaded('a', '/ws/pkg/a', { build: { exec: { command: 'b' }, dependsOn: [] } })]

    const inv = buildInventory({ workspace, configs })

    expect(inv.projects[0]!.targets[0]).toEqual({ name: 'build', command: 'b' })
  })

  it('emits an empty targets array for a project that loaded no config', () => {
    const workspace = ws('/ws', [
      { name: 'configured', dir: '/ws/pkg/c' },
      { name: 'bare', dir: '/ws/pkg/b' },
    ])
    const configs = [loaded('configured', '/ws/pkg/c', { x: { exec: { command: 'x' } } })]

    const inv = buildInventory({ workspace, configs })

    const bare = inv.projects.find((p) => p.name === 'bare')!
    expect(bare.targets).toEqual([])
  })

  it('does not invent targets for projects not present in the workspace', () => {
    const workspace = ws('/ws', [{ name: 'a', dir: '/ws/pkg/a' }])
    const configs = [
      loaded('a', '/ws/pkg/a', { x: { exec: { command: 'x' } } }),
      loaded('ghost', '/ws/pkg/ghost', { y: { exec: { command: 'y' } } }),
    ]

    const inv = buildInventory({ workspace, configs })

    expect(inv.projects.map((p) => p.name)).toEqual(['a'])
  })
})
