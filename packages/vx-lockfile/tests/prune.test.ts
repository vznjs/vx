// `vx prune` end to end, through the CLI, in a workspace that declares the
// plugin: the subset copied, the workspace lists rewritten, and the pruned
// lockfile installed by the real package manager with a frozen lockfile —
// offline: every dependency is a workspace package or a `file:` directory
// inside the project that names it. bun always runs; pnpm, npm and yarn
// (classic) run where their binary is on PATH.
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')

type Pm = 'bun' | 'pnpm' | 'npm' | 'yarn'
const LOCKFILE: Record<Pm, string> = {
  bun: 'bun.lock',
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
}

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function scratch(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

/**
 * The install, frozen or not, with every cache under `home`, never the
 * network. Frozen, it fails unless the lockfile is what the install would
 * write.
 */
function install(
  pm: Pm,
  cwd: string,
  home: string,
  frozen: boolean,
): { code: number; out: string } {
  const cmd: Record<Pm, string[]> = {
    bun: ['bun', 'install', ...(frozen ? ['--frozen-lockfile'] : [])],
    pnpm: [
      'pnpm',
      'install',
      '--offline',
      `--store-dir=${home}/store`,
      frozen ? '--frozen-lockfile' : '--no-frozen-lockfile',
    ],
    npm: frozen ? ['npm', 'ci', '--offline'] : ['npm', 'install', '--offline'],
    // Yarn 1's --frozen-lockfile passes a workspace lockfile missing what
    // the install needs (it did for the control below), so yarn's check
    // is its own install leaving the lockfile byte-identical.
    yarn: ['yarn', 'install', '--offline'],
  }
  const lockfile = path.join(cwd, LOCKFILE[pm])
  const before = pm === 'yarn' && frozen ? readFileSync(lockfile, 'utf8') : ''
  const r = Bun.spawnSync({
    cmd: cmd[pm],
    cwd,
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: `${home}/cache`,
      XDG_DATA_HOME: `${home}/data`,
      BUN_INSTALL_CACHE_DIR: `${home}/bun`,
      npm_config_cache: `${home}/npm`,
      YARN_CACHE_FOLDER: `${home}/yarn`,
      CI: '1',
    },
  })
  const out = r.stdout.toString() + r.stderr.toString()
  if (pm === 'yarn' && frozen && r.exitCode === 0 && readFileSync(lockfile, 'utf8') !== before) {
    return { code: 1, out: `yarn install rewrote yarn.lock\n${out}` }
  }
  return { code: r.exitCode, out }
}

function vx(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, ...args],
    cwd,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

/**
 * `app` → the workspace package `lib` and `dep-app`; `lib` → `dep-lib`;
 * `other` → `dep-other`. Each `dep-*` is a `file:` directory inside the
 * project naming it, so an install needs no registry.
 */
async function workspace(pm: Pm, home: string): Promise<string> {
  const root = await scratch(`vx-prune-${pm}-`)
  const link = pm === 'bun' || pm === 'pnpm' ? 'workspace:*' : '1.0.0'
  const manifest = (name: string, deps: Record<string, string>): string =>
    `${JSON.stringify({ name, version: '1.0.0', dependencies: deps }, null, 2)}\n`
  if (pm === 'pnpm') {
    await write(path.join(root, 'package.json'), '{ "name": "ws", "private": true }\n')
    await write(
      path.join(root, 'pnpm-workspace.yaml'),
      `# the members
packages:
  - packages/*

onlyBuiltDependencies: []
`,
    )
  } else {
    await write(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
    )
  }
  const project = async (name: string, deps: Record<string, string>): Promise<void> => {
    const dir = path.join(root, 'packages', name)
    await write(
      path.join(dir, 'package.json'),
      manifest(name, { ...deps, [`dep-${name}`]: `file:./vendor/dep-${name}` }),
    )
    await write(
      path.join(dir, 'vendor', `dep-${name}`, 'package.json'),
      manifest(`dep-${name}`, {}),
    )
    await write(path.join(dir, 'src', 'index.js'), `export const name = '${name}'\n`)
  }
  await project('app', { lib: link })
  await project('lib', {})
  await project('other', {})
  await write(path.join(root, 'packages', 'app', 'vx.config.mjs'), 'export default { tasks: {} }\n')
  await write(
    path.join(root, 'vx.workspace.mjs'),
    `import { ${pm} } from ${JSON.stringify(PLUGIN_INDEX)}
export default { plugins: [${pm}()] }
`,
  )
  const r = install(pm, root, home, false)
  expect({ code: r.code, out: r.code === 0 ? '' : r.out }).toEqual({ code: 0, out: '' })
  return root
}

/** Every file under `dir`, relative, sorted. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort()
}

const available = (pm: Pm): boolean => Bun.which(pm) !== null

describe.each(['bun', 'pnpm', 'npm', 'yarn'] as const)('vx prune with %s()', (pm) => {
  it.skipIf(!available(pm))(
    'writes json/ and full/, and the pruned lockfile installs frozen; another subset’s does not',
    async () => {
      const home = await scratch('vx-prune-home-')
      const root = await workspace(pm, home)
      const lockfile = LOCKFILE[pm]
      const source = await Bun.file(path.join(root, lockfile)).text()
      expect(source).toContain('dep-other')

      const r = vx(root, 'prune', 'app', '--docker')
      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' })
      expect(r.stdout).toBe(
        `vx prune: 2 projects → out (json/ + full/), ${lockfile} pruned\n` +
          '  app (packages/app)\n' +
          '  lib (packages/lib)\n',
      )
      const workspaceFile = pm === 'pnpm' ? 'pnpm-workspace.yaml' : 'package.json'
      const installLayer = [
        lockfile,
        ...(pm === 'pnpm' ? ['package.json'] : []),
        workspaceFile,
        'packages/app/package.json',
        'packages/lib/package.json',
      ].sort()
      expect(await files(path.join(root, 'out', 'json'))).toEqual(installLayer)
      expect(await files(path.join(root, 'out', 'full'))).toEqual(
        [
          ...installLayer,
          'packages/app/src/index.js',
          'packages/app/vendor/dep-app/package.json',
          'packages/app/vx.config.mjs',
          'packages/lib/src/index.js',
          'packages/lib/vendor/dep-lib/package.json',
          'vx.workspace.mjs',
        ].sort(),
      )
      const full = path.join(root, 'out', 'full')
      const pruned = await Bun.file(path.join(full, lockfile)).text()
      expect(pruned).toContain('dep-lib')
      expect(pruned).not.toContain('dep-other')
      expect(pruned).not.toContain('packages/other')
      if (pm === 'pnpm') {
        expect(await Bun.file(path.join(full, 'pnpm-workspace.yaml')).text()).toBe(`# the members
packages:
  - "packages/app"
  - "packages/lib"

onlyBuiltDependencies: []
`)
      } else {
        const ws = (await Bun.file(path.join(full, 'package.json')).json()) as {
          workspaces: string[]
        }
        expect(ws.workspaces).toEqual(['packages/app', 'packages/lib'])
      }

      const frozen = install(pm, full, home, true)
      expect({ code: frozen.code, out: frozen.code === 0 ? '' : frozen.out }).toEqual({
        code: 0,
        out: '',
      })
      expect(await Bun.file(path.join(full, lockfile)).text()).toBe(pruned)

      // CONTROL: the frozen install reads the lockfile — the one pruned for
      // `other` does not install `app` and `lib`.
      const otherOut = path.join(root, 'out-other')
      expect(vx(root, 'prune', 'other', '--out-dir', otherOut).code).toBe(0)
      const control = await scratch('vx-prune-control-')
      await rm(control, { recursive: true })
      await Bun.$`cp -R ${full} ${control}`.quiet()
      await rm(path.join(control, 'node_modules'), { recursive: true, force: true })
      await writeFile(
        path.join(control, lockfile),
        await Bun.file(path.join(otherOut, lockfile)).text(),
      )
      expect(install(pm, control, home, true).code).not.toBe(0)
    },
    60_000,
  )
})

describe('vx prune without an install', () => {
  async function bare(): Promise<string> {
    const root = await scratch('vx-prune-refuse-')
    await write(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] })}\n`,
    )
    await write(path.join(root, 'packages', 'a', 'package.json'), '{ "name": "a" }\n')
    await write(
      path.join(root, 'vx.workspace.mjs'),
      // Two of the four: one package, one `prune` (core refused two
      // plugins on one verb before a verb's owner was its package).
      `import { bun, npm } from ${JSON.stringify(PLUGIN_INDEX)}
export default { plugins: [bun(), npm()] }
`,
    )
    return root
  }

  it('an out dir inside a pruned project, one with content, and an unknown project', async () => {
    const root = await bare()
    await write(path.join(root, 'taken', 'x'), '')
    expect(vx(root, 'prune', 'a', '--out-dir', 'packages/a/out')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'vx prune: --out-dir packages/a/out is inside a, which the subset copies — pick a path outside it\n',
    })
    expect(vx(root, 'prune', 'a', '--out-dir', 'taken')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'vx prune: --out-dir taken already has content — remove it or name an empty directory\n',
    })
    expect(vx(root, 'prune', 'nope', 'a')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'vx prune: no project named "nope" (the root is always kept; name the projects under it)\n',
    })
    expect(vx(root, 'prune', 'a', '--out-dir', '.').stderr).toBe(
      'vx prune: --out-dir . is or contains the workspace root\n',
    )
    // CONTROL: an empty existing directory is fine.
    await mkdir(path.join(root, 'empty'))
    expect(vx(root, 'prune', 'a', '--out-dir', 'empty').code).toBe(0)
    expect(await files(path.join(root, 'empty'))).toEqual([
      'package.json',
      'packages/a/package.json',
      'vx.workspace.mjs',
    ])
  })

  it('a workspace package a copied vx config imports comes along, with its closure', async () => {
    // The config loads before any task: without its local plugin, `vx run`
    // in the image cannot start. The import is never evaluated here.
    const root = await bare()
    await write(
      path.join(root, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: {} }
export const later = () => import('tool/plugin.mjs')
`,
    )
    await write(
      path.join(root, 'packages', 'tool', 'package.json'),
      '{ "name": "tool", "dependencies": { "base": "*" } }\n',
    )
    await write(path.join(root, 'packages', 'base', 'package.json'), '{ "name": "base" }\n')
    await write(path.join(root, 'packages', 'idle', 'package.json'), '{ "name": "idle" }\n')
    const r = vx(root, 'prune', 'a')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      'vx prune: 3 projects → out\n  a (packages/a)\n  base (packages/base)\n  tool (packages/tool)\n',
    )
  })

  it('a dir holding a glob character is listed as itself, not as a pattern', async () => {
    // `packages/a[1]` written raw is a class: it matched `packages/a1`, so
    // neither vx nor bun found the pruned project in the copy.
    const root = await bare()
    await rm(path.join(root, 'packages', 'a'), { recursive: true })
    const dirs = ['a[1]', 'b*', 'c{d}', 'plain']
    for (const d of dirs)
      await write(path.join(root, 'packages', d, 'package.json'), `{ "name": "p-${d[0]}" }\n`)
    // Decoys each raw pattern would match instead.
    for (const d of ['a1', 'bx', 'cd'])
      await write(path.join(root, 'packages', d, 'package.json'), `{ "name": "decoy-${d}" }\n`)
    const names = dirs.map((d) => `p-${d[0]}`)
    expect(vx(root, 'prune', ...names).code).toBe(0)
    const out = path.join(root, 'out')
    const ws = (await Bun.file(path.join(out, 'package.json')).json()) as { workspaces: string[] }
    expect(ws.workspaces).toEqual([
      'packages/a[[]1]',
      'packages/b[*]',
      'packages/c[{]d}',
      'packages/plain',
    ])
    for (const d of ['a1', 'bx', 'cd'])
      await write(path.join(out, 'packages', d, 'package.json'), `{ "name": "decoy-${d}" }\n`)
    const shown = vx(out, 'show', '--format', 'json')
    expect(shown.code).toBe(0)
    expect((JSON.parse(shown.stdout) as { dir: string }[]).map((p) => p.dir).sort()).toEqual(
      dirs.map((d) => `packages/${d}`).sort(),
    )
    const bun = install('bun', out, await scratch('vx-prune-home-'), false)
    expect(bun.code).toBe(0)
    const lock = Bun.JSONC.parse(await Bun.file(path.join(out, 'bun.lock')).text()) as {
      workspaces: Record<string, unknown>
    }
    expect(Object.keys(lock.workspaces).sort()).toEqual(
      ['', ...dirs.map((d) => `packages/${d}`)].sort(),
    )
  })

  it('a binary bun.lockb with no bun.lock', async () => {
    const root = await bare()
    await write(path.join(root, 'bun.lockb'), 'bun-lockfile-format-v0\n')
    expect(vx(root, 'prune', 'a').stderr).toBe(
      'vx prune: bun.lockb is binary and cannot be pruned — `bun install --save-text-lockfile` writes bun.lock\n',
    )
  })
})
