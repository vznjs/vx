// `nx-exec` against REAL Nx. `VX_NX_MODULES` names a directory whose
// `node_modules` holds `nx`, `@nx/js` and `typescript` (CI installs one;
// locally: `npm i --prefix <dir> nx @nx/js typescript`). Without it the
// suite skips — and a skip is a silent pass, so `VX_REQUIRE_NX=1` (CI)
// makes an absent install a failure.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const MODULES = process.env['VX_NX_MODULES']
const REQUIRED = process.env['VX_REQUIRE_NX'] === '1'
const TIMEOUT = 120_000

if (REQUIRED && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset — the live nx-exec suite cannot run')
}

let root: string

async function nxExec(cwd: string, args: string[]) {
  const p = Bun.spawn(['node', BIN, ...args], {
    cwd,
    env: { ...process.env, NX_DAEMON: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

describe.skipIf(!MODULES)('nx-exec against real Nx', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-live-'))
    await symlink(path.join(MODULES!, 'node_modules'), path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'package.json'), '{"name":"live","private":true}')
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ namedInputs: { default: ['{projectRoot}/**/*'] }, targetDefaults: {} }),
    )
    await writeFile(
      path.join(root, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2022', module: 'commonjs', declaration: true, strict: true },
      }),
    )
    const dir = path.join(root, 'packages', 'lib')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), '{"name":"@live/lib","version":"0.0.0"}')
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { outDir: '../../dist/from-tsconfig', rootDir: 'src' },
        include: ['src/**/*.ts'],
      }),
    )
    await writeFile(
      path.join(dir, 'src', 'index.ts'),
      'export const one = (x: number): number => x + 1\n',
    )
    await writeFile(
      path.join(dir, 'project.json'),
      JSON.stringify({
        name: 'lib',
        sourceRoot: 'packages/lib/src',
        projectType: 'library',
        targets: {
          // project.json says one outputPath; the command line will say another.
          build: {
            executor: '@nx/js:tsc',
            options: {
              outputPath: 'dist/from-project-json',
              main: 'packages/lib/src/index.ts',
              tsConfig: 'packages/lib/tsconfig.json',
            },
          },
          here: { executor: 'nx:run-commands', options: { command: 'pwd', cwd: '{projectRoot}' } },
        },
      }),
    )
  })

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it(
    'with no cached graph, the first call computes one and tsc writes where the COMMAND says',
    async () => {
      const cwd = path.join(root, 'packages', 'lib')
      const r = await nxExec(cwd, [
        '@nx/js:tsc',
        '--project',
        'lib',
        '--target',
        'build',
        '--options',
        JSON.stringify({
          outputPath: 'dist/from-command',
          main: 'packages/lib/src/index.ts',
          tsConfig: 'packages/lib/tsconfig.json',
        }),
      ])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(
        await Bun.file(path.join(root, 'dist', 'from-command', 'src', 'index.js')).exists(),
      ).toBe(true)
      expect(
        await Bun.file(path.join(root, 'dist', 'from-project-json', 'src', 'index.js')).exists(),
      ).toBe(false)
      // The fallback wrote Nx's own cache for the next task.
      expect(
        await Bun.file(path.join(root, '.nx', 'workspace-data', 'project-graph.json')).exists(),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'run-commands options resolved by the graph run as given; a failing command is exit 1; a configuration is accepted',
    async () => {
      const cwd = path.join(root, 'packages', 'lib')
      const ok = await nxExec(cwd, [
        'nx:run-commands',
        '--project',
        'lib',
        '--target',
        'here',
        '--options',
        JSON.stringify({ command: 'pwd', cwd: 'packages/lib' }),
      ])
      expect(ok.code).toBe(0)
      expect(ok.out).toContain(path.join(root, 'packages', 'lib'))
      const bad = await nxExec(cwd, [
        'nx:run-commands',
        '--project',
        'lib',
        '--target',
        'here',
        '--options',
        JSON.stringify({ command: 'exit 3' }),
      ])
      expect(bad.code).toBe(1)
      const cfg = await nxExec(cwd, [
        'nx:run-commands',
        '--project',
        'lib',
        '--target',
        'here',
        '--configuration',
        'production',
        '--options',
        JSON.stringify({ command: 'echo cfg-ok' }),
      ])
      expect({ code: cfg.code, hit: cfg.out.includes('cfg-ok') }).toEqual({ code: 0, hit: true })
    },
    TIMEOUT,
  )

  it(
    'an executor the workspace does not have is exit 1 with Nx’s own message',
    async () => {
      const r = await nxExec(path.join(root, 'packages', 'lib'), [
        '@nx/nope:zzz',
        '--project',
        'lib',
        '--target',
        'build',
      ])
      expect(r.code).toBe(1)
      expect(r.err).toContain('@nx/nope')
    },
    TIMEOUT,
  )
})
