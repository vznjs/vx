// `{ externalDependencies }` hashes the named packages' resolved versions.
// A name the root manifest declares was dropped as "keyed already, with or
// without a lockfile plugin", but core keys no lockfile: with `nx()` alone a
// `left-pad` bump in package-lock.json was a hit where Nx re-runs (hunt,
// 2026-11-06). With no plugin claiming the lockfile the task keys it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '@vzn/vx'
import { planRun, run } from '../../vx/tests/helpers/orchestrator.js'
import { CLAIM_FILE_IMPORT } from './helpers/claim-file.js'
import { fakeNx, fakeNxCli } from './helpers/fake-nx.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 30_000

const silent = (): Logger =>
  ({
    status() {},
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }) as unknown as Logger

const lockfile = (version: string) =>
  JSON.stringify({
    name: 'ws',
    lockfileVersion: 3,
    packages: {
      '': { name: 'ws', devDependencies: { 'left-pad': '^1.0.0' } },
      'node_modules/left-pad': { version, dev: true },
    },
  })

async function workspace(plugins: string[]): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(
      plugins,
      `import { nx } from ${JSON.stringify(PLUGIN_INDEX)}\n${CLAIM_FILE_IMPORT}`,
    ),
  )
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-external-deps-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, devDependencies: { 'left-pad': '^1.0.0' } }),
  )
  await writeFile(path.join(root, 'package-lock.json'), lockfile('1.2.0'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: {} }))
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n.vx/cache/\n.nx\n')
  const lib = path.join(root, 'packages', 'lib')
  await mkdir(path.join(lib, 'src'), { recursive: true })
  await writeFile(path.join(lib, 'package.json'), JSON.stringify({ name: 'lib' }))
  await writeFile(path.join(lib, 'src', 'index.js'), '// lib\n')
  const graph = {
    graph: {
      nodes: {
        lib: {
          name: 'lib',
          type: 'lib',
          data: {
            root: 'packages/lib',
            targets: {
              lint: {
                executor: 'nx:run-commands',
                cache: true,
                outputs: [],
                inputs: ['{projectRoot}/src/**/*', { externalDependencies: ['left-pad'] }],
                options: { command: 'echo lint' },
              },
            },
          },
        },
      },
      dependencies: { lib: [] },
    },
  }
  await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
  await fakeNx(root)
  await fakeNxCli(root)
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'with no plugin claiming the lockfile, a bump of a root dependency it names re-runs the task',
  async () => {
    await workspace(["nx({ graph: 'graph.json' })"])
    const opts = { cwd: root, tasks: ['lib#lint'], log: silent(), handleSignals: false }
    const statusOf = (r: Awaited<ReturnType<typeof run>>) =>
      r.outcomes.find((o) => o.node.id === 'lib#lint')!.status
    expect(statusOf(await run(opts))).toBe('success')
    expect(statusOf(await run(opts))).toBe('cache-hit')
    await writeFile(path.join(root, 'package-lock.json'), lockfile('1.3.0'))
    expect(statusOf(await run(opts))).toBe('success')
  },
  TIMEOUT,
)

it(
  'a plugin claiming the lockfile keys the dependencies, so the task lists no lockfile of its own',
  async () => {
    const workspaceFiles = async () =>
      (await planRun({ cwd: root, tasks: ['lib#lint'], log: silent() })).tasks.find(
        (t) => t.node.id === 'lib#lint',
      )!.node.config.inputs?.workspaceFiles ?? []
    await workspace(["nx({ graph: 'graph.json' })"])
    expect(await workspaceFiles()).toContain('package-lock.json')
    await workspace(["nx({ graph: 'graph.json' })", "claimFile('package-lock.json')"])
    expect(await workspaceFiles()).not.toContain('package-lock.json')
  },
  TIMEOUT,
)
