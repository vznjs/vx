// The Nx path end to end against REAL Nx, on a package-based and an
// integrated workspace: `vx init` writes `nx()`, `vx run build --all`
// runs through it, `bunx @vzn/vx-migrate` writes native config, and with
// `nx()` removed (the guide's last step) the same build runs green from
// that config alone, the executor target as its `nx-exec` line. Live
// against `VX_NX_MODULES`, as `nx-exec-live` is.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const MODULES = process.env['VX_NX_MODULES']
if (process.env['VX_REQUIRE_NX'] === '1' && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset — the live nx-exec suite cannot run')
}
const TIMEOUT = 300_000
const PKG = path.resolve(import.meta.dir, '..')
const VX = path.resolve(PKG, '..', 'vx', 'src', 'bin.ts')
const MIGRATE = path.join(PKG, 'src', 'bin.ts')

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

/** The workspace's node_modules: Nx from the live install, vx and this package from the repo. */
async function linkModules(root: string): Promise<void> {
  const from = path.join(MODULES!, 'node_modules')
  const to = path.join(root, 'node_modules')
  await mkdir(path.join(to, '.bin'), { recursive: true })
  await mkdir(path.join(to, '@vzn'), { recursive: true })
  for (const entry of await readdir(from)) {
    if (entry === '.bin' || entry === '@vzn' || entry.startsWith('.')) continue
    await symlink(path.join(from, entry), path.join(to, entry))
  }
  for (const bin of await readdir(path.join(from, '.bin'))) {
    await symlink(await realpath(path.join(from, '.bin', bin)), path.join(to, '.bin', bin))
  }
  await symlink(path.resolve(PKG, '..', 'vx'), path.join(to, '@vzn', 'vx'))
  await symlink(PKG, path.join(to, '@vzn', 'vx-migrate'))
  await symlink(path.join(PKG, 'src', 'nx-exec.cjs'), path.join(to, '.bin', 'nx-exec'))
  await symlink(path.join(PKG, 'src', 'nx-env.cjs'), path.join(to, '.bin', 'nx-env'))
}

async function writeTree(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(
      path.join(root, rel),
      typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`,
    )
  }
}

const tsc = (dir: string) => ({
  executor: '@nx/js:tsc',
  outputs: ['{options.outputPath}'],
  options: {
    outputPath: `dist/${dir}`,
    main: `${dir}/src/index.ts`,
    tsConfig: `${dir}/tsconfig.lib.json`,
  },
})
const tsconfig = {
  compilerOptions: { module: 'commonjs', target: 'es2020', rootDir: 'src', declaration: false },
  include: ['src/**/*.ts'],
}
const write = (file: string) => `node -e "require('fs').writeFileSync('${file}', 'built')"`

/** `[name, files, the dirs the note says to list (integrated only), outputs]` */
const SHAPES = [
  [
    'package-based',
    {
      'package.json': { name: 'pb', private: true, workspaces: ['packages/*'] },
      'nx.json': { targetDefaults: { build: { dependsOn: ['^build'] } } },
      'tsconfig.base.json': { compilerOptions: {} },
      'packages/lib/package.json': {
        name: 'lib',
        version: '0.0.0',
        nx: { targets: { build: tsc('packages/lib') } },
      },
      'packages/lib/tsconfig.lib.json': tsconfig,
      'packages/lib/src/index.ts': 'export const x = 1\n',
      'packages/app/package.json': {
        name: 'app',
        version: '0.0.0',
        dependencies: { lib: '*' },
        scripts: { build: write('app.txt') },
      },
    },
    undefined,
    ['dist/packages/lib/src/index.js', 'packages/app/app.txt'],
  ],
  [
    'integrated',
    {
      'package.json': { name: 'int', private: true },
      'nx.json': { targetDefaults: { build: { dependsOn: ['^build'] } } },
      'tsconfig.base.json': { compilerOptions: {} },
      'libs/util/project.json': { name: 'util', targets: { build: tsc('libs/util') } },
      'libs/util/tsconfig.lib.json': tsconfig,
      'libs/util/src/index.ts': 'export const y = 2\n',
      'apps/cli/project.json': {
        name: 'cli',
        implicitDependencies: ['util'],
        targets: {
          build: {
            executor: 'nx:run-commands',
            options: { command: write('cli.txt'), cwd: 'apps/cli' },
          },
        },
      },
    },
    ['libs/*', 'apps/*'],
    ['dist/libs/util/src/index.js', 'apps/cli/cli.txt'],
  ],
] as const

describe.skipIf(!MODULES)('an Nx workspace from vx init to native config, live', () => {
  for (const [name, files, globs, outputs] of SHAPES) {
    it(
      name,
      async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), `vx-nx-e2e-${name}-`)))
        roots.push(root)
        await writeTree(root, { ...files, '.gitignore': 'node_modules\n.nx\n.vx\ndist\n' })
        await linkModules(root)
        const env = {
          PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env['PATH']}`,
          HOME: process.env['HOME']!,
          NX_DAEMON: 'false',
          NX_TUI: 'false',
          NX_NO_CLOUD: 'true',
          NX_ISOLATE_PLUGINS: 'false',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        }
        const run = async (cmd: string[]) => {
          const p = Bun.spawn(cmd, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
          const [out, err, code] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited,
          ])
          return { code, tail: code === 0 ? '' : `${out}\n${err}`.slice(-4000) }
        }
        const git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@t']
        await run([...git, 'init', '-q'])
        await run([...git, 'add', '-A'])
        await run([...git, 'commit', '-qm', 'init'])
        const built = async () =>
          Promise.all(outputs.map((o) => Bun.file(path.join(root, o)).exists()))
        const clean = async () => {
          for (const o of outputs) await rm(path.join(root, o), { force: true })
          await rm(path.join(root, '.vx'), { recursive: true, force: true })
        }

        // 1. vx init: the temporary start.
        expect(await run(['bun', VX, 'init'])).toEqual({ code: 0, tail: '' })
        expect(await readFile(path.join(root, 'vx.workspace.ts'), 'utf8')).toContain('nx()')

        // 2. The build through nx(), executors as nx-exec.
        expect(await run(['bun', VX, 'run', 'build', '--all'])).toEqual({ code: 0, tail: '' })
        expect(await built()).toEqual(outputs.map(() => true))

        // 3. The migrator writes native config.
        await clean()
        // The sandbox has no registry: installing vx is adopt.test.ts's.
        expect(await run(['bun', MIGRATE, '--no-install'])).toEqual({ code: 0, tail: '' })
        if (globs !== undefined) {
          // Follow the note: list the integrated projects' directories.
          const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
          await writeFile(
            path.join(root, 'package.json'),
            JSON.stringify({ ...pkg, workspaces: globs }),
          )
        }

        // 4. Without nx() the native config alone builds; the executor is its nx-exec line.
        await writeFile(path.join(root, 'vx.workspace.ts'), 'export default {}\n')
        const lib = outputs[0].split('/').slice(1, 3).join('/')
        expect(await readFile(path.join(root, lib, 'vx.config.ts'), 'utf8')).toContain(
          'nx-exec @nx/js:tsc',
        )
        expect(await run(['bun', VX, 'run', 'build', '--all'])).toEqual({ code: 0, tail: '' })
        expect(await built()).toEqual(outputs.map(() => true))
      },
      TIMEOUT,
    )
  }
})
