// `nx-exec` against REAL Nx. `VX_NX_MODULES` names a directory whose
// `node_modules` holds `nx`, `@nx/js` and `typescript` (CI installs one;
// locally: `npm i --prefix <dir> nx @nx/js typescript`). Without it the
// suite skips — and a skip is a silent pass, so `VX_REQUIRE_NX=1` (CI)
// makes an absent install a failure.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mapRunCommands } from '../src/nx-command.js'
import { mapNxWorkspace } from '../src/nx/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const NX_ENV = path.resolve(import.meta.dir, '..', 'src', 'nx-env.cjs')
const MODULES = process.env['VX_NX_MODULES']
const REQUIRED = process.env['VX_REQUIRE_NX'] === '1'
const TIMEOUT = 120_000

if (REQUIRED && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset — the live nx-exec suite cannot run')
}

let root: string

/** A target that prints what its environment holds, with an `envFile` (the dotenv row). */
const SHOWENV = {
  executor: 'nx:run-commands',
  options: {
    command: `printf '%s|' "$A" "$B" "$C" "$D" "$E" > envout.txt`,
    envFile: '.env.custom',
  },
}

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
          showenv: SHOWENV,
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

  // The line `nx()` maps a run-commands target to, against Nx's own
  // run-commands executor on the same options and the same forwarded
  // arguments: what each wrote, and whether it failed.
  describe('a run-commands line does what Nx’s run-commands does', () => {
    const rel = (f: string) => path.join(root, f)
    const OUTS = ['one.txt', 'two.txt', 's.txt', 'd.txt', 'e.txt', 'term.txt', 'up']

    async function outcome(run: () => Promise<number>) {
      for (const f of OUTS) await rm(rel(f), { force: true })
      const code = await run()
      const files: Record<string, string> = {}
      for (const f of OUTS) {
        // A TERMed command's trap writes after the line has returned.
        if (f === 'term.txt')
          for (let i = 0; i < 200 && !(await Bun.file(rel(f)).exists()); i++) await Bun.sleep(10)
        if (await Bun.file(rel(f)).exists()) files[f] = await Bun.file(rel(f)).text()
      }
      return { failed: code !== 0, files }
    }

    async function nxRuns(options: Record<string, unknown>, args: string[]) {
      return outcome(async () => {
        const r = await nxExec(path.join(root, 'packages', 'lib'), [
          'nx:run-commands',
          '--project',
          'lib',
          '--target',
          'here',
          '--options',
          JSON.stringify(options),
          ...args,
        ])
        return r.code
      })
    }

    async function vxRuns(options: Record<string, unknown>, args: string[]) {
      const todos: string[] = []
      const mapped = mapRunCommands(
        options,
        { projectRel: 'packages/lib', projectName: 'lib' },
        todos,
      )
      return outcome(async () => {
        const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ')
        const p = Bun.spawn(
          ['sh', '-c', args.length > 0 ? `${mapped!.command} ${quoted}` : mapped!.command],
          {
            cwd: path.join(root, 'packages', 'lib'),
            env: { ...process.env, ...mapped!.env },
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
            detached: true,
          },
        )
        return p.exited
      })
    }

    const put = (name: string, words: string) => `printf '%s|' ${words} > ${name}`
    const rows: [string, Record<string, unknown>, string[]][] = [
      [
        'parallel by default; an unconsumed option and the forwarded arguments reach each command',
        { commands: [put('one.txt', 'one'), put('two.txt', 'two')], extra: 'x y' },
        // Positional first: `runExecutor` re-serializes the overrides with
        // positional words ahead of flags, where `nx run` and vx keep the order.
        ['free word', '--otp=123'],
      ],
      [
        'in order, forwardAllArgs off on one',
        {
          commands: [
            put('one.txt', 'one'),
            { command: put('two.txt', 'two'), forwardAllArgs: false },
          ],
          parallel: false,
        },
        ['--otp=123'],
      ],
      [
        '{args}',
        { command: `${put('s.txt', '{args}')}`, region: 'eu', args: '--tag=x' },
        ['--otp=1'],
      ],
      [
        '{args.name} from the options',
        { command: put('d.txt', '{args.region} {args.tag}'), region: 'eu', args: '--tag x' },
        [],
      ],
      ['env', { command: `printf '%s' "$OUT" > e.txt`, env: { OUT: 'abc' } }, []],
      [
        'a failing command fails the parallel run and TERMs the other',
        {
          commands: [
            'trap "echo terminated > term.txt; exit 143" TERM; : > up; while :; do sleep 0.05; done',
            'while [ ! -f up ]; do sleep 0.01; done; exit 3',
          ],
        },
        [],
      ],
      ['an empty list', { commands: [] }, []],
    ]
    for (const [title, options, args] of rows) {
      it(
        title,
        async () => {
          const nx = await nxRuns(options, args)
          const vx = await vxRuns(options, args)
          expect(vx).toEqual(nx)
        },
        TIMEOUT,
      )
    }
  })

  it(
    'a task’s `.env` files and `envFile` give the line what `nx run` gives the task',
    async () => {
      const files: Record<string, string> = {
        '.env': 'A=root\nB=root\nC=root\nD=${A}-x\n',
        '.env.local': 'C=local\n',
        '.env.custom': 'B=custom\nE=custom\n',
        'packages/lib/.env': 'A=project\n',
        'packages/lib/.env.showenv': 'B=target\n',
      }
      for (const [f, text] of Object.entries(files)) await writeFile(path.join(root, f), text)
      const bare = {
        PATH: process.env['PATH']!,
        HOME: process.env['HOME']!,
        NX_DAEMON: 'false',
        NX_TUI: 'false',
        NX_NO_CLOUD: 'true',
      }
      const out = path.join(root, 'envout.txt')
      try {
        await rm(out, { force: true })
        const nx = Bun.spawn(
          [path.join(root, 'node_modules', '.bin', 'nx'), 'run', 'lib:showenv', '--skip-nx-cache'],
          { cwd: root, env: bare, stdout: 'pipe', stderr: 'pipe' },
        )
        const [nxOut, nxErr, nxCode] = await Promise.all([
          new Response(nx.stdout).text(),
          new Response(nx.stderr).text(),
          nx.exited,
        ])
        expect({ code: nxCode, tail: nxCode === 0 ? '' : nxOut + nxErr }).toEqual({
          code: 0,
          tail: '',
        })
        const byNx = await Bun.file(out).text()
        // The same target through the mapper, run as vx runs it.
        await rm(out, { force: true })
        const mapped = await mapNxWorkspace(
          root,
          [
            {
              name: '@live/lib',
              dir: path.join(root, 'packages', 'lib'),
              packageJson: { name: '@live/lib' },
              configPath: null,
            },
          ],
          {
            nodes: {
              lib: { name: 'lib', data: { root: 'packages/lib', targets: { showenv: SHOWENV } } },
            },
            dependencies: {},
          },
          { persistentTodo: 'n/a', cacheable: new Set() },
        )
        const exec = mapped.projects[0]!.tasks.find((t) => t.name === 'showenv')!.task!['exec'] as {
          command: string
        }
        const bin = path.join(root, 'live-bin')
        await mkdir(bin, { recursive: true })
        await symlink(NX_ENV, path.join(bin, 'nx-env')).catch(() => {})
        const vx = Bun.spawn(['sh', '-c', exec.command], {
          cwd: path.join(root, 'packages', 'lib'),
          env: { ...bare, PATH: `${bin}:${bare.PATH}` },
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        })
        const [vxErr, vxCode] = await Promise.all([new Response(vx.stderr).text(), vx.exited])
        expect({ code: vxCode, err: vxErr }).toEqual({ code: 0, err: '' })
        expect({ vx: await Bun.file(out).text(), nx: byNx }).toEqual({
          vx: 'project|target|local|project-x|custom|',
          nx: 'project|target|local|project-x|custom|',
        })
      } finally {
        for (const f of Object.keys(files)) await rm(path.join(root, f), { force: true })
      }
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
