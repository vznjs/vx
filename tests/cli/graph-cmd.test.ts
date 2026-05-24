import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { makeWorkspaceAsync } from '../../src/_testkit/fixtures.ts'
import { graphCommand } from '../../src/cli/graph-cmd.ts'

function collect() {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  return {
    stdoutChunks,
    stderrChunks,
    write: (chunk: string) => stdoutChunks.push(chunk),
    writeErr: (chunk: string) => stderrChunks.push(chunk),
    out: () => stdoutChunks.join(''),
    err: () => stderrChunks.join(''),
  }
}

describe('graphCommand', () => {
  it('prints "no tasks" when nothing is requested', async () => {
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
    expect(io.out()).toMatch(/no tasks/i)
  })

  it('prints the graph in text format by default', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': `
        export default {
          tasks: {
            build: { exec: { command: 'echo b' }, dependsOn: ['compile'] },
            compile: { exec: { command: 'echo c' } },
          },
        }
      `,
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: ['build'],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(0)
    expect(io.out()).toContain('solo#compile')
    expect(io.out()).toContain('solo#build')
  })

  it('honors --json', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': 'export default { tasks: { x: { exec: { command: "x" } } } }',
    })
    const io = collect()

    await graphCommand({
      cwd: root,
      positional: ['x'],
      flags: { json: true },
      write: io.write,
      writeErr: io.writeErr,
    })

    const parsed = JSON.parse(io.out())
    expect(parsed.nodes).toHaveLength(1)
  })

  it('honors --dot', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': 'export default { tasks: { x: { exec: { command: "x" } } } }',
    })
    const io = collect()

    await graphCommand({
      cwd: root,
      positional: ['x'],
      flags: { dot: true },
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(io.out()).toMatch(/^digraph/)
  })

  it('returns non-zero and writes a clean error message on graph errors', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': 'export default { tasks: { x: { exec: { command: "x" } } } }',
    })
    const io = collect()

    const code = await graphCommand({
      cwd: root,
      positional: ['nope'],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/no project declares task "nope"/)
  })

  it('discovers a multi-project workspace and lists fan-out tasks', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","workspaces":["pkg/*"]}',
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { test: { exec: { command: "a t" } } } }',
      'pkg/b/package.json': '{"name":"b"}',
      'pkg/b/vx.config.ts': 'export default { tasks: { test: { exec: { command: "b t" } } } }',
    })
    const io = collect()

    await graphCommand({
      cwd: join(root, 'pkg/a'),
      positional: ['test'],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(io.out()).toContain('a#test')
    expect(io.out()).toContain('b#test')
  })

  it('returns non-zero when not inside any workspace', async () => {
    const io = collect()

    const code = await graphCommand({
      cwd: '/tmp/this-path-should-have-no-workspace-marker-anywhere',
      positional: ['build'],
      flags: {},
      write: io.write,
      writeErr: io.writeErr,
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/workspace/i)
  })
})
