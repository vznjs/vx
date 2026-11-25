// A run reads the lock, never turbo.json, a script, project.json or the Nx
// graph, and calls no `project` hook (owner, 2026-11-25: "You need to run vx
// lock every time the Nx graph changes. No vx lock, we run what's already
// locked."). An edit runs the locked command, unrefused, until `vx lock`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { lock } from '@vzn/vx/testing'
import { fakeNx, fakeNxCli } from './helpers/fake-nx.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 30_000

/** Each planned task's command, by id. */
async function commands(root: string, tasks: string[]): Promise<Record<string, string>> {
  const plan = await planRun({ cwd: root, tasks, log: silent() })
  return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.command ?? '']))
}

describe('turbo(): a file the lock was mapped from, edited since', () => {
  const ws = useTurboWorkspace({ tasks: { build: { outputs: ['dist/**'] } } })
  const lib = () => path.join(ws.root, 'packages', 'lib', 'package.json')
  const script = (build: string) =>
    writeFile(lib(), JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { build } }))

  for (const clone of [false, true]) {
    it(
      `runs the locked script${clone ? ' in a fresh clone' : ''}, the edited one once \`vx lock\` mapped it`,
      async () => {
        await lock(ws.root)
        if (clone) await rm(path.join(ws.root, '.vx', 'cache'), { recursive: true, force: true })
        await script('echo edited')
        await writeFile(
          path.join(ws.root, 'turbo.json'),
          JSON.stringify({ tasks: { build: { outputs: ['dist/**'], env: ['MODE'] } } }),
        )
        expect((await commands(ws.root, ['lib#build']))['lib#build']).toContain('echo lib')
        await lock(ws.root)
        expect((await commands(ws.root, ['lib#build']))['lib#build']).toContain('echo edited')
      },
      TIMEOUT,
    )
  }
})

describe('nx(): a file the lock was mapped from, edited since', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-edited-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: {} }))
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n.vx/cache/\n.nx\n')
    const dir = path.join(root, 'packages', 'lib')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(path.join(dir, 'project.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(path.join(dir, 'src', 'index.js'), '// lib\n')
    const lint = { executor: 'nx:run-commands', options: { command: 'echo lint' } }
    const graph = {
      graph: {
        nodes: {
          lib: { name: 'lib', type: 'lib', data: { root: 'packages/lib', targets: { lint } } },
        },
        dependencies: { lib: [] },
      },
    }
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    // What Nx records beside its graph: the file each target was inferred from.
    await writeFile(path.join(dir, 'vite.config.ts'), 'export default {}\n')
    await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'source-maps.json'),
      JSON.stringify({
        'packages/lib': {
          root: ['packages/lib/project.json', 'nx/core/project-json'],
          'targets.lint': ['packages/lib/vite.config.ts', '@nx/vite/plugin'],
        },
      }),
    )
    await fakeNx(root)
    await fakeNxCli(root)
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource(['nx()'], `import { nx } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  // `nx graph` is a spawn of the fake bin, counted in `nx-calls`.
  for (const clone of [false, true]) {
    it(
      `runs the locked target and spawns no \`nx graph\`${clone ? ' in a fresh clone' : ''}`,
      async () => {
        await lock(root)
        const calls = path.join(root, 'nx-calls')
        expect(await Bun.file(calls).exists()).toBe(true)
        await rm(calls)
        if (clone) await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
        await writeFile(
          path.join(root, 'packages', 'lib', 'project.json'),
          JSON.stringify({ name: 'lib', targets: { lint: { command: 'echo edited' } } }),
        )
        await writeFile(
          path.join(root, 'packages', 'lib', 'vite.config.ts'),
          'export default { build: {} }\n',
        )
        const graph = path.join(root, 'graph.json')
        await writeFile(graph, (await Bun.file(graph).text()).replace('echo lint', 'echo edited'))
        const lint = (await commands(root, ['lint']))['lib#lint']
        expect([lint?.includes('echo lint'), lint?.includes('edited')]).toEqual([true, false])
        expect(await Bun.file(calls).exists()).toBe(false)
        // CONTROL: `vx lock` maps through the graph, and the run follows it.
        await lock(root)
        expect(await Bun.file(calls).exists()).toBe(true)
        expect((await commands(root, ['lint']))['lib#lint']).toContain('echo edited')
      },
      TIMEOUT,
    )
  }
})
