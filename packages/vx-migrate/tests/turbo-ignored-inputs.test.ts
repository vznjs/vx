// G-146: Turbo hashes a path turbo.json names whether git ignores it or
// not. A gitignored `config.local.json` in globalDependencies and a task
// input `secret.local.txt` stay literals, which core keys from disk.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lock, planRun } from '@vzn/vx/testing'
import { DOTENV_PROBE, DOTENV_PROBE_TOP, ignoredFilesProbe } from '../src/dotenv-probe.js'
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

  // The lock is committed; what git ignores is on one machine only. Naming
  // each ignored file a glob matched put a local `src/env.local` into it, and
  // a fresh clone refused every run and failed `vx lock --check`.
  it('a gitignored file under a glob is not named, so two machines lock alike', async () => {
    const root = ws.root
    const lib = path.join(root, 'packages', 'lib')
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { gen: { inputs: ['src/**'], outputs: [] } } }),
    )
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { gen: 'cat src/*' } }),
    )
    await writeFile(path.join(root, '.gitignore'), 'dist\n*.local\nout/\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const locked = async () => {
      await lock(root)
      return Bun.file(path.join(root, '.vx', 'projects.lock')).text()
    }
    const clean = await locked()
    await mkdir(path.join(lib, 'src', 'out'), { recursive: true })
    await writeFile(path.join(lib, 'src', 'env.local'), 'a\n')
    await writeFile(path.join(lib, 'src', 'out', 'deep.ts'), 'a\n')
    expect(await locked()).toBe(clean)
  }, 30_000)

  // Whether git ignores a literal path can differ by machine: a `dir/` rule
  // matches `out` only where the directory exists, and `.git/info/exclude`
  // is not committed. Core keys a named ignored path from disk itself, so the
  // lock holds the literal as written either way.
  it('a literal input locks alike whether this machine ignores it or not', async () => {
    const root = ws.root
    const lib = path.join(root, 'packages', 'lib')
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ['conf.json'],
        tasks: { gen: { inputs: ['src/**', 'out', 'gen.txt'], outputs: [] } },
      }),
    )
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { gen: 'cat gen.txt' } }),
    )
    await writeFile(path.join(root, '.gitignore'), 'dist\nout/\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const locked = async () => {
      await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
      await lock(root)
      return Bun.file(path.join(root, '.vx', 'projects.lock')).text()
    }
    const clean = await locked()
    await mkdir(path.join(lib, 'out'), { recursive: true })
    await writeFile(path.join(lib, 'out', 'a.txt'), 'a\n')
    await writeFile(path.join(lib, 'gen.txt'), 'a\n')
    await writeFile(path.join(root, 'conf.json'), '{}\n')
    await writeFile(path.join(root, '.git', 'info', 'exclude'), 'gen.txt\nconf.json\n')
    expect(await locked()).toBe(clean)
  }, 30_000)
})

// The probe that keys an uncached producer's outputs (`dependencyOutputs`).
describe('turbo-map: ignoredFilesProbe', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-ignored-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
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
