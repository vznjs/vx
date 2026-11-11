// G-146: Turbo hashes a path turbo.json names whether git ignores it or
// not. Core refuses a literal input git ignores, so a gitignored
// `config.local.json` in globalDependencies ran every task uncached and a
// task input `secret.local.txt` its task; a probe keys each now.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { DOTENV_PROBE, DOTENV_PROBE_TOP, ignoredFilesProbe } from '../src/dotenv-probe.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'
import { ownSplice } from './helpers/turbo-own.js'

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

  // An explicit glob is walked on disk by Turbo, gitignored files and all
  // (`$TURBO_DEFAULT$` alone skips them): `src/**` over an ignored
  // `src/gen.ts` replayed the old output after an edit there.
  it('a gitignored file or directory an explicit glob matches keys the task', async () => {
    const root = ws.root
    const lib = path.join(root, 'packages', 'lib')
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { gen: { inputs: ['src/**', '!src/skip.ts'], outputs: [] } } }),
    )
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { gen: 'cat src/*' } }),
    )
    await writeFile(path.join(root, '.gitignore'), 'dist\ngen.ts\nskip.ts\nout/\nnode_modules\n')
    await mkdir(path.join(lib, 'src', 'out'), { recursive: true })
    await mkdir(path.join(lib, 'src', 'node_modules'), { recursive: true })
    const gen = path.join(lib, 'src', 'gen.ts')
    const deep = path.join(lib, 'src', 'out', 'deep.ts')
    await writeFile(gen, 'a\n')
    await writeFile(deep, 'a\n')
    await writeFile(path.join(lib, 'src', 'skip.ts'), 'a\n')
    await writeFile(path.join(lib, 'src', 'node_modules', 'm.js'), 'a\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const key = async () => {
      const plan = await planRun({ cwd: root, tasks: ['gen'], log: silent() })
      return plan.tasks.find((t) => t.node.id === 'lib#gen')!.hash
    }
    const first = await key()
    await writeFile(gen, 'b\n')
    const genEdit = await key()
    await writeFile(deep, 'b\n')
    const deepEdit = await key()
    await writeFile(path.join(lib, 'src', 'skip.ts'), 'b\n')
    await writeFile(path.join(lib, 'src', 'node_modules', 'm.js'), 'b\n')
    expect({
      cached: /^[0-9a-f]{16}$/.test(first),
      genMoved: genEdit !== first,
      deepMoved: deepEdit !== genEdit,
      takenBackStill: (await key()) === deepEdit,
    }).toEqual({ cached: true, genMoved: true, deepMoved: true, takenBackStill: true })
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
    const metas: PackageMeta[] = [
      { name: 'a', dir: pkgDir, packageJson: { name: 'a', scripts } as never, configPath: null },
    ]
    const asked: string[][] = []
    const ignore = new Set(['config.local.json', 'packages/a/secret.local.txt', 'root.local'])
    const m = await mapTurboWorkspace(dir, metas, {
      splice: ownSplice,
      persistentTodo: 'PERSIST',
      ignored: async (rels) => {
        asked.push([...rels].sort())
        return new Set(rels.filter((r) => ignore.has(r)))
      },
    })
    const inputs = Object.fromEntries(
      m.projects[0]!.tasks.map((t) => [t.name, (t.task as { inputs: unknown }).inputs]),
    )
    expect({ globals: m.globals.inputs, asked, inputs }).toEqual({
      globals: ['tsconfig.json', 'certs/*.pem'],
      asked: [
        ['config.local.json', 'tsconfig.json'],
        ['config.local.json', 'packages/a/README.md', 'packages/a/secret.local.txt', 'root.local'],
      ],
      inputs: {
        build: {
          files: ['src/**', 'README.md', 'package.json'],
          workspaceFiles: ['tsconfig.json', 'certs/*.pem'],
          workspaceRuntime: [
            ignoredFilesProbe(['config.local.json', 'packages/a/secret.local.txt', 'root.local']),
          ],
        },
        only: {
          files: ['!x/**', 'package.json'],
          workspaceFiles: ['tsconfig.json', 'certs/*.pem'],
          workspaceRuntime: [
            ignoredFilesProbe(['config.local.json', 'packages/a/secret.local.txt']),
          ],
        },
      },
    })
  })

  it('names each ignored path an explicit glob matches, in the list that holds the glob', async () => {
    await writeFile(
      path.join(dir, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ['certs/*.pem'],
        tasks: {
          // The edge keeps gen cached: without it, a glob over make's output runs gen uncached.
          gen: {
            dependsOn: ['make'],
            inputs: ['src/**/*.ts', '!src/skip.ts', '$TURBO_ROOT$/conf/*.json'],
          },
          dflt: { inputs: ['$TURBO_DEFAULT$'] },
          make: { inputs: ['make.txt'], outputs: ['src/made.ts'] },
        },
      }),
    )
    const pkgDir = path.join(dir, 'packages', 'a')
    await mkdir(pkgDir, { recursive: true })
    const scripts = { gen: 'g', dflt: 'd', make: 'm' }
    // A package nested in `a` is another project: its path is named from the root.
    const inner = path.join(pkgDir, 'src', 'inner')
    const metas: PackageMeta[] = [
      { name: 'a', dir: pkgDir, packageJson: { name: 'a', scripts } as never, configPath: null },
      { name: 'inner', dir: inner, packageJson: { name: 'inner' } as never, configPath: null },
    ]
    const asked: string[][] = []
    const m = await mapTurboWorkspace(dir, metas, {
      splice: ownSplice,
      persistentTodo: 'PERSIST',
      ignoredUnder: async (globs) => {
        asked.push([...globs].sort())
        return [
          'certs/dev.pem',
          'conf/local.json',
          'packages/a/src/gen.ts',
          'packages/a/src/gen.js',
          'packages/a/src/skip.ts',
          'packages/a/src/made.ts',
          'packages/a/src/inner/gen.ts',
          'packages/a/src/[id]/',
          'packages/a/dist/',
        ]
      },
    })
    const inputs = Object.fromEntries(
      m.projects[0]!.tasks.map((t) => [t.name, (t.task as { inputs: unknown }).inputs]),
    )
    expect({ asked, inputs }).toEqual({
      // `inner` has no script: the edge makes it a no-op gen, which Turbo hashes.
      asked: [
        [
          'certs/*.pem',
          'conf/*.json',
          'packages/a/src/**/*.ts',
          'packages/a/src/inner/src/**/*.ts',
        ],
      ],
      inputs: {
        // A sibling's output, taken back from the glob, is not named back.
        gen: {
          files: [
            'src/**/*.ts',
            '!src/skip.ts',
            'package.json',
            '!src/made.ts',
            'src/gen.ts',
            'src/\\[id\\]/**/*.ts',
          ],
          workspaceFiles: [
            'certs/*.pem',
            'conf/*.json',
            'packages/a/src/inner/**/*.ts',
            'packages/a/src/inner/gen.ts',
            'conf/local.json',
            'certs/dev.pem',
          ],
        },
        dflt: {
          files: ['**/*', '!src/made.ts'],
          workspaceFiles: [
            'certs/*.pem',
            'packages/a/**/*',
            '!packages/a/src/made.ts',
            'certs/dev.pem',
          ],
        },
        make: {
          files: ['make.txt', 'package.json'],
          workspaceFiles: ['certs/*.pem', 'certs/dev.pem'],
        },
      },
    })
  })

  // Core keys a probe on its output trimmed (cache/inputs.ts), so each
  // file ends on a `.`: a newline added to the last file is an edit.
  it.each([
    ['ignoredFilesProbe', ignoredFilesProbe(['it s', 'gone', '.env'])],
    ['DOTENV_PROBE', DOTENV_PROBE],
    ['DOTENV_PROBE_TOP', DOTENV_PROBE_TOP],
  ])('%s keys each file by name and bytes, a trailing newline too', async (_, probe) => {
    await writeFile(path.join(dir, 'it s'), 'x\n')
    await writeFile(path.join(dir, '.env'), 'A=1\n')
    const run = () => Bun.spawnSync(['sh', '-c', probe], { cwd: dir }).stdout.toString().trim()
    const before = run()
    await writeFile(path.join(dir, '.env'), 'A=1\n\n')
    expect(run()).not.toBe(before)
  })
})
