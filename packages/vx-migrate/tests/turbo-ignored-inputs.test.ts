// G-146: Turbo hashes a path turbo.json names whether git ignores it or
// not. Core refuses a literal input git ignores, so a gitignored
// `config.local.json` in globalDependencies ran every task uncached and a
// task input `secret.local.txt` its task; a probe keys each now.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, type ProjectMeta } from '@vzn/vx'
import { ignoredFilesProbe } from '../src/dotenv-probe.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  globalDependencies: ['config.local.json'],
  tasks: { build: { inputs: ['src/**', 'secret.local.txt'], outputs: ['dist/**'] } },
})

describe('turbo(): gitignored inputs named by path', () => {
  it('key the task, which stays cached, and an edit to one re-keys it', async () => {
    const root = ws.root
    await writeFile(path.join(root, '.gitignore'), 'dist\n*.local.json\nsecret.local.txt\n')
    const rootFile = path.join(root, 'config.local.json')
    const pkgFile = path.join(root, 'packages', 'lib', 'secret.local.txt')
    await writeFile(rootFile, '{}\n')
    await writeFile(pkgFile, 'a\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const key = async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return plan.tasks.find((t) => t.node.id === 'lib#build')!.hash
    }
    const first = await key()
    await writeFile(rootFile, '{"a":1}\n')
    const rootEdit = await key()
    await writeFile(pkgFile, 'a\n\n')
    const pkgEdit = await key()
    expect({
      cached: /^[0-9a-f]{16}$/.test(first),
      rootMoved: rootEdit !== first,
      pkgMoved: pkgEdit !== rootEdit,
      stable: (await key()) === pkgEdit,
    }).toEqual({ cached: true, rootMoved: true, pkgMoved: true, stable: true })
  }, 30_000)
})

// A literal path git ignores leaves the file lists (core refuses one) and
// is keyed by a probe; a tracked one and a glob stay files.
describe('turbo-map: gitignored inputs named by path', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-ignored-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('probes each ignored literal, from the list that named it, and asks only for literals', async () => {
    await writeFile(
      path.join(dir, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ['config.local.json', 'tsconfig.json', 'certs/*.pem'],
        tasks: {
          build: {
            inputs: ['src/**', 'secret.local.txt', '$TURBO_ROOT$/root.local', 'README.md'],
          },
          only: { inputs: ['secret.local.txt', '!x/**'] },
        },
      }),
    )
    const pkgDir = path.join(dir, 'packages', 'a')
    await mkdir(pkgDir, { recursive: true })
    const scripts = { build: 'b', only: 'o' }
    const metas: ProjectMeta[] = [
      { name: 'a', dir: pkgDir, packageJson: { name: 'a', scripts } as never, configPath: null },
    ]
    const asked: string[][] = []
    const ignore = new Set(['config.local.json', 'packages/a/secret.local.txt', 'root.local'])
    const m = await mapTurboWorkspace(dir, metas, {
      splice: (_k, v) => v,
      persistentTodo: 'PERSIST',
      ignored: async (rels) => {
        asked.push([...rels].sort())
        return new Set(rels.filter((r) => ignore.has(r)))
      },
    })
    const inputs = Object.fromEntries(
      m.projects[0]!.tasks.map((t) => [
        t.name,
        (t.task as { cache: { inputs: unknown } }).cache.inputs,
      ]),
    )
    expect({ globals: m.globals.inputs, asked, inputs }).toEqual({
      globals: ['tsconfig.json', 'certs/*.pem'],
      asked: [
        ['config.local.json', 'tsconfig.json'],
        ['config.local.json', 'packages/a/README.md', 'packages/a/secret.local.txt', 'root.local'],
      ],
      inputs: {
        build: {
          files: ['src/**', 'README.md'],
          workspaceFiles: ['tsconfig.json', 'certs/*.pem'],
          workspaceRuntime: [
            ignoredFilesProbe(['config.local.json', 'packages/a/secret.local.txt', 'root.local']),
          ],
        },
        only: {
          files: [],
          workspaceFiles: ['tsconfig.json', 'certs/*.pem'],
          workspaceRuntime: [
            ignoredFilesProbe(['config.local.json', 'packages/a/secret.local.txt']),
          ],
        },
      },
    })
  })

  it('a probe keys each file by name and bytes, a trailing newline too', async () => {
    await writeFile(path.join(dir, 'it s'), 'x\n')
    const run = () =>
      Bun.spawnSync(['sh', '-c', ignoredFilesProbe(['it s', 'gone'])], {
        cwd: dir,
      }).stdout.toString()
    const before = run()
    await writeFile(path.join(dir, 'it s'), 'x\n\n')
    expect([before, run()]).toEqual(['it s\nx\n.\n', 'it s\nx\n\n.\n'])
  })
})
