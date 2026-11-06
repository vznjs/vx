// `{ dependentTasksOutputFiles }` from a `cache: false` producer: vx folds
// the producer's key, which covers its inputs, never what an uncached task
// fetched from outside. A `fetch` writing a gitignored schema from a remote
// and a cached `codegen` reading it replayed v1 after fetch wrote v2, where
// Nx hashes the file and re-runs (hunt, 2026-11-06).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '@vzn/vx'
import { run } from '../../vx/tests/helpers/orchestrator.js'
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

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-uncached-producer-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: {} }))
  await writeFile(
    path.join(root, '.gitignore'),
    'node_modules\n.vx/cache/\n.nx\nremote.txt\ngen\nout\n',
  )
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
              fetch: {
                executor: 'nx:run-commands',
                cache: false,
                outputs: ['{projectRoot}/gen'],
                options: {
                  command: 'mkdir -p gen && cat ../../remote.txt > gen/schema.json',
                  cwd: 'packages/lib',
                },
              },
              codegen: {
                executor: 'nx:run-commands',
                cache: true,
                dependsOn: ['fetch'],
                inputs: ['{projectRoot}/src/**/*', { dependentTasksOutputFiles: '**/*.json' }],
                outputs: ['{projectRoot}/out'],
                options: {
                  command: 'mkdir -p out && cat gen/schema.json > out/types.txt',
                  cwd: 'packages/lib',
                },
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
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(
      ["nx({ graph: 'graph.json' })"],
      `import { nx } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
    ),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'a cached reader of an uncached producer’s outputs re-runs when the producer writes new bytes',
  async () => {
    const opts = { cwd: root, tasks: ['lib#codegen'], log: silent(), handleSignals: false }
    const out = path.join(root, 'packages', 'lib', 'out', 'types.txt')
    const statusOf = (r: Awaited<ReturnType<typeof run>>) =>
      r.outcomes.find((o) => o.node.id === 'lib#codegen')!.status
    await writeFile(path.join(root, 'remote.txt'), 'v1\n')
    expect(statusOf(await run(opts))).toBe('success')
    expect(await Bun.file(out).text()).toBe('v1\n')
    await writeFile(path.join(root, 'remote.txt'), 'v2\n')
    expect(statusOf(await run(opts))).toBe('success')
    expect(await Bun.file(out).text()).toBe('v2\n')
    // Still cached: the same fetched bytes are a hit.
    expect(statusOf(await run(opts))).toBe('cache-hit')
    expect(await Bun.file(out).text()).toBe('v2\n')
  },
  TIMEOUT,
)
