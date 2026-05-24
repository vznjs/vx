// End-to-end test: spawns `bun src/bin.ts graph ...` against a real
// fixture workspace and verifies stdout/stderr/exit code. Covers the
// whole pipeline (bin -> cli dispatcher -> workspace discovery ->
// config load -> inventory build -> JSON output).

import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

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
  it('emits a JSON inventory for a single-project workspace', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'vx.config.ts': `
        export default {
          tasks: {
            build: { exec: { command: 'tsc' }, dependsOn: ['compile'] },
            compile: { exec: { command: 'echo c' } },
          },
        }
      `,
    })

    const { stdout, code } = await runVx(['graph'], root)

    expect(code).toBe(0)
    const inv = JSON.parse(stdout)
    expect(inv.workspace.root).toBe(root)
    expect(inv.projects).toHaveLength(1)
    expect(inv.projects[0].name).toBe('solo')
    expect(inv.projects[0].targets.map((t: { name: string }) => t.name)).toEqual([
      'build',
      'compile',
    ])
  })

  it('walks up to find the workspace root when invoked from a subdirectory', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","workspaces":["pkg/*"]}',
      'pkg/a/package.json': '{"name":"a"}',
      'pkg/a/vx.config.ts': 'export default { tasks: { build: { exec: { command: "echo a" } } } }',
      'pkg/a/src/x.ts': 'export const x = 1',
    })

    const { stdout, code } = await runVx(['graph'], join(root, 'pkg/a/src'))

    expect(code).toBe(0)
    const inv = JSON.parse(stdout)
    expect(inv.projects.find((p: { name: string }) => p.name === 'a').targets[0].name).toBe('build')
  })

  it("emits raw ^name deps without resolving (resolution is the runner's job)", async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root"}',
      'pnpm-workspace.yaml': "packages:\n  - 'pkg/*'\n",
      'pkg/lib/package.json': '{"name":"lib"}',
      'pkg/lib/vx.config.ts':
        'export default { tasks: { build: { exec: { command: "lib build" } } } }',
      'pkg/app/package.json': '{"name":"app"}',
      'pkg/app/vx.config.ts': `
        export default {
          tasks: {
            installDeps: { exec: { command: 'npm i' }, dependsOn: ['^build'] },
          },
        }
      `,
    })

    const { stdout, code } = await runVx(['graph'], root)

    expect(code).toBe(0)
    const inv = JSON.parse(stdout)
    const app = inv.projects.find((p: { name: string }) => p.name === 'app')
    expect(app.targets[0].dependsOn).toEqual(['^build'])
  })

  it('rejects positional arguments', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
    })

    const { stderr, code } = await runVx(['graph', 'build'], root)

    expect(code).toBe(1)
    expect(stderr).toMatch(/no positional arguments/i)
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

  it('emits an empty inventory shape when the workspace has no projects', async () => {
    const root = await makeWorkspaceAsync({
      'random.txt': 'not a workspace',
      'package.json': '{"name":"solo"}',
    })

    const { stdout, code } = await runVx(['graph'], root)

    expect(code).toBe(0)
    const inv = JSON.parse(stdout)
    expect(inv.projects).toEqual([{ name: 'solo', dir: root, targets: [] }])
  })
})
