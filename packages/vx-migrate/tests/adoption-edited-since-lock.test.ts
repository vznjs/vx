// A run reads the lock, never turbo.json, a script or project.json: an edit
// to one with no `vx lock` after it ran the old command, green (a script
// edit even missed the cache, the old command saved under the new key). As
// for an edited vx.config, the run maps the file again and refuses a mapping
// that moved, naming the file and `vx lock`.
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
const said = (file: string) => `${file} changed since the last \`vx lock\` — run \`vx lock\``

describe('turbo(): a file the lock was mapped from, edited since', () => {
  const ws = useTurboWorkspace({ tasks: { build: { outputs: ['dist/**'] } } })
  const plan = () => planRun({ cwd: ws.root, tasks: ['build'], log: silent() })

  it(
    'refuses the run for a script edit, then runs once `vx lock` read it',
    async () => {
      await lock(ws.root)
      expect((await plan()).tasks.length).toBe(2)
      const manifest = path.join(ws.root, 'packages', 'lib', 'package.json')
      await writeFile(
        manifest,
        JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { build: 'echo edited' } }),
      )
      await expect(plan()).rejects.toThrow(said('packages/lib/package.json'))
      await lock(ws.root)
      expect((await plan()).tasks.length).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'refuses the run for a turbo.json edit',
    async () => {
      await lock(ws.root)
      await writeFile(
        path.join(ws.root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['dist/**'], env: ['MODE'] } } }),
      )
      await expect(plan()).rejects.toThrow(said('turbo.json'))
    },
    TIMEOUT,
  )

  it(
    'refuses the run for a package turbo.json that appeared since',
    async () => {
      await lock(ws.root)
      await writeFile(
        path.join(ws.root, 'packages', 'lib', 'turbo.json'),
        JSON.stringify({ extends: ['//'], tasks: { build: { env: ['MODE'] } } }),
      )
      await expect(plan()).rejects.toThrow(said('packages/lib/turbo.json'))
    },
    TIMEOUT,
  )

  // The stamp is held to ctime and the inode, as a vx.config's is: a
  // same-length edit with its mtime set back skipped the byte check.
  it(
    'refuses a same-length turbo.json edit whose mtime was set back',
    async () => {
      const turbo = path.join(ws.root, 'turbo.json')
      const text = await Bun.file(turbo).text()
      const old = new Date(Date.now() - 3_600_000)
      await utimes(turbo, old, old)
      await lock(ws.root)
      const before = await stat(turbo)
      await writeFile(turbo, text.replace('dist/**', 'dust/**'))
      await utimes(turbo, before.atime, before.mtime)
      const now = await stat(turbo)
      expect([now.size, now.mtimeMs]).toEqual([before.size, before.mtimeMs])
      await expect(plan()).rejects.toThrow(said('turbo.json'))
    },
    TIMEOUT,
  )

  it(
    'runs when a file was rewritten with the same bytes',
    async () => {
      await lock(ws.root)
      const turbo = path.join(ws.root, 'turbo.json')
      await writeFile(turbo, await Bun.file(turbo).text())
      expect((await plan()).tasks.length).toBe(2)
    },
    TIMEOUT,
  )
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
  // A run maps an edited file again and refuses only a mapping that moved
  // (63c8d1b8f): the graph Nx would build from the edit.
  const graphMoves = async (): Promise<void> => {
    const file = path.join(root, 'graph.json')
    await writeFile(file, (await Bun.file(file).text()).replace('echo lint', 'echo edited'))
  }

  it(
    'refuses the run, naming project.json and `vx lock`',
    async () => {
      await lock(root)
      const plan = () => planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect((await plan()).tasks.length).toBe(1)
      await writeFile(
        path.join(root, 'packages', 'lib', 'project.json'),
        JSON.stringify({ name: 'lib', targets: { lint: { command: 'echo edited' } } }),
      )
      await graphMoves()
      await expect(plan()).rejects.toThrow(said('packages/lib/project.json'))
    },
    TIMEOUT,
  )

  it(
    'refuses the run for a project.json that appeared since',
    async () => {
      const project = path.join(root, 'packages', 'lib', 'project.json')
      await rm(project)
      await lock(root)
      const plan = () => planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect((await plan()).tasks.length).toBe(1)
      await writeFile(project, JSON.stringify({ name: 'lib' }))
      await graphMoves()
      await expect(plan()).rejects.toThrow(said('packages/lib/project.json'))
    },
    TIMEOUT,
  )

  it(
    'refuses the run for an edit to the file a target was inferred from',
    async () => {
      await lock(root)
      const plan = () => planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect((await plan()).tasks.length).toBe(1)
      await writeFile(
        path.join(root, 'packages', 'lib', 'vite.config.ts'),
        'export default { build: {} }\n',
      )
      await graphMoves()
      await expect(plan()).rejects.toThrow(said('packages/lib/vite.config.ts'))
    },
    TIMEOUT,
  )
})
