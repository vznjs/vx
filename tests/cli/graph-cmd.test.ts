import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { graphCommand } from '../../src/cli/graph-cmd.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

function collect() {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  return {
    write: (chunk: string) => stdoutChunks.push(chunk),
    writeErr: (chunk: string) => stderrChunks.push(chunk),
    out: () => stdoutChunks.join(''),
    err: () => stderrChunks.join(''),
  }
}

describe('graphCommand', () => {
  it('emits a JSON inventory with the workspace root', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: [],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(0)
    const inv = JSON.parse(io.out())
    expect(inv).toEqual({
      workspace: { root },
      projects: [{ name: 'solo', dir: root, targets: [] }],
    })
  })

  it('includes every declared target in the JSON inventory', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': `
        export default {
          tasks: {
            build: { description: 'compile', exec: { command: 'tsc' }, dependsOn: ['compile'] },
            compile: { exec: { command: 'echo c' } },
            ci: { dependsOn: ['build'] },
          },
        }
      `,
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: [],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(0)
    const inv = JSON.parse(io.out())
    expect(inv.projects[0].targets).toEqual([
      { name: 'build', description: 'compile', command: 'tsc', dependsOn: ['compile'] },
      { name: 'compile', command: 'echo c' },
      { name: 'ci', dependsOn: ['build'] },
    ])
  })

  it('emits raw ^name and pkg#task deps without resolving them', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': `
        export default {
          tasks: {
            installDeps: { exec: { command: 'npm i' }, dependsOn: ['^build', 'other#x'] },
          },
        }
      `,
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: [],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(0)
    const inv = JSON.parse(io.out())
    expect(inv.projects[0].targets[0].dependsOn).toEqual(['^build', 'other#x'])
  })

  it('lists multiple packages in a pnpm-style workspace', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root"}',
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/vx.config.ts': 'export default { tasks: { build: { exec: { command: "a" } } } }',
      'packages/b/package.json': '{"name":"b"}',
      'packages/b/vx.config.ts': 'export default { tasks: { build: { exec: { command: "b" } } } }',
    })
    const io = collect()

    await graphCommand({
      cwd: join(root, 'packages/a'),
      positional: [],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    const inv = JSON.parse(io.out())
    expect(inv.projects.map((p: { name: string }) => p.name).sort()).toEqual(['a', 'b'])
  })

  it('emits projects with empty targets when they declare no vx.config', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","workspaces":["pkg/*"]}',
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/b/package.json': '{"name":"b"}',
      'pkg/b/vx.config.ts': 'export default { tasks: { x: { exec: { command: "x" } } } }',
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: [],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(0)
    const inv = JSON.parse(io.out())
    const a = inv.projects.find((p: { name: string }) => p.name === 'a')
    const b = inv.projects.find((p: { name: string }) => p.name === 'b')
    expect(a.targets).toEqual([])
    expect(b.targets).toEqual([{ name: 'x', command: 'x' }])
  })

  it('rejects positional arguments — graph is a no-arg inventory dump', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: ['build'],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/no positional arguments/i)
  })

  it('exits 1 when no workspace is found', async () => {
    const io = collect()

    const code = await graphCommand({
      cwd: '/tmp/this-path-should-have-no-workspace-marker-anywhere',
      positional: [],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/workspace/i)
  })
})
