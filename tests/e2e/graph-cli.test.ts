// End-to-end test: spawns `bun src/bin.ts graph ...` against a real
// fixture workspace and verifies stdout/stderr/exit code. Covers the
// whole pipeline (bin -> cli dispatcher -> workspace discovery ->
// config load -> graph build -> format).

import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { makeWorkspaceAsync } from '../../src/_testkit/fixtures.ts'

const BIN = join(import.meta.dir, '../..', 'src/bin.ts')

async function runVx(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', BIN, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { stdout, stderr, code }
}

describe('vx graph (e2e)', () => {
  it('prints the graph for a single-project workspace', async () => {
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

    const { stdout, code } = await runVx(['graph', 'build'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('solo#compile')
    expect(stdout).toContain('solo#build')
    expect(stdout.indexOf('solo#compile')).toBeLessThan(stdout.indexOf('solo#build'))
  })

  it('emits JSON with --json', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts':
        'export default { tasks: { x: { description: "ex", exec: { command: "echo x" } } } }',
    })

    const { stdout, code } = await runVx(['graph', 'x', '--json'], root)

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0]).toMatchObject({
      id: 'solo#x',
      command: 'echo x',
      description: 'ex',
    })
  })

  it('emits DOT with --dot', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': `
        export default {
          tasks: {
            a: { exec: { command: 'a' }, dependsOn: ['b'] },
            b: { exec: { command: 'b' } },
          },
        }
      `,
    })

    const { stdout, code } = await runVx(['graph', 'a', '--dot'], root)

    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(/^digraph/)
    expect(stdout).toContain('"solo#b" -> "solo#a"')
  })

  it('walks up to find the workspace root when invoked from a subdirectory', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","workspaces":["pkg/*"]}',
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { build: { exec: { command: "echo a" } } } }',
      'pkg/a/src/x.ts': 'export const x = 1',
    })

    const { stdout, code } = await runVx(['graph', 'build'], join(root, 'pkg/a/src'))

    expect(code).toBe(0)
    expect(stdout).toContain('a#build')
  })

  it('exits 1 with a clean error when no project declares the task', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': 'export default { tasks: { x: { exec: { command: "x" } } } }',
    })

    const { stderr, code } = await runVx(['graph', 'nope'], root)

    expect(code).toBe(1)
    expect(stderr).toMatch(/no project declares task "nope"/)
  })

  it('prints help with no command', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
    })

    const { stdout, code } = await runVx([], root)

    expect(code).toBe(0)
    expect(stdout).toMatch(/Usage: vx/)
    expect(stdout).toContain('graph')
  })

  it('reports an unknown command and exits 1', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
    })

    const { stderr, code } = await runVx(['nonsense'], root)

    expect(code).toBe(1)
    expect(stderr).toMatch(/unknown command "nonsense"/)
  })

  it('handles a multi-project workspace with cross-project deps', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","workspaces":["pkg/*"]}',
      'pkg/lib/package.json': '{"name":"lib"}',
      'pkg/lib/vx.config.ts':
        'export default { tasks: { build: { exec: { command: "lib build" } } } }',
      'pkg/app/package.json': '{"name":"app"}',
      'pkg/app/vx.config.ts': `
        export default {
          tasks: {
            build: { exec: { command: 'app build' }, dependsOn: ['lib#build'] },
          },
        }
      `,
    })

    const { stdout, code } = await runVx(['graph', 'app#build'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('lib#build')
    expect(stdout).toContain('app#build')
    expect(stdout.indexOf('lib#build')).toBeLessThan(stdout.indexOf('app#build'))
  })
})
