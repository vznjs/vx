// `nx run` takes an executor's outcome from its generator's RETURN value
// when it has one, else the last yield (P2-40). A workspace-local executor
// that returns without yielding, or yields success and returns failure,
// exits the same under `nx run` and under `nx-exec`. Live against
// `VX_NX_MODULES`, as `nx-exec-live` is.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const MODULES = process.env['VX_NX_MODULES']
if (process.env['VX_REQUIRE_NX'] === '1' && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset — the live nx-exec suite cannot run')
}
const TIMEOUT = 120_000

let root: string

describe.skipIf(!MODULES)('nx-exec reads an executor outcome as nx run does', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-ret-')))
    await symlink(path.join(MODULES!, 'node_modules'), path.join(root, 'node_modules'))
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"live","private":true,"workspaces":["tools/*"]}',
    )
    await writeFile(path.join(root, 'nx.json'), '{}')
    const plugin = path.join(root, 'tools', 'outcome')
    await mkdir(plugin, { recursive: true })
    await writeFile(
      path.join(plugin, 'package.json'),
      '{"name":"outcome","version":"0.0.0","executors":"./executors.json"}',
    )
    await writeFile(
      path.join(plugin, 'executors.json'),
      '{"executors":{"gen":{"implementation":"./gen.js","schema":"./schema.json"}}}',
    )
    await writeFile(
      path.join(plugin, 'schema.json'),
      '{"type":"object","properties":{"yields":{"type":"array"},"returns":{"type":"boolean"}}}',
    )
    await writeFile(
      path.join(plugin, 'gen.js'),
      'module.exports = async function* (options) {\n' +
        '  for (const ok of options.yields ?? []) yield { success: ok }\n' +
        '  return { success: options.returns }\n' +
        '}\n',
    )
    await writeFile(path.join(plugin, 'project.json'), '{"name":"outcome"}')
    const lib = path.join(root, 'packages', 'lib')
    await mkdir(lib, { recursive: true })
    const target = (yields: boolean[], returns: boolean) => ({
      executor: './tools/outcome:gen',
      options: { yields, returns },
    })
    await writeFile(
      path.join(lib, 'project.json'),
      JSON.stringify({
        name: 'lib',
        targets: {
          'return-ok': target([], true),
          'yield-ok-return-fail': target([true], false),
        },
      }),
    )
  })
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it(
    'a returned outcome decides the exit under both',
    async () => {
      const env = {
        PATH: process.env['PATH']!,
        HOME: process.env['HOME']!,
        NX_DAEMON: 'false',
        NX_TUI: 'false',
        NX_NO_CLOUD: 'true',
        NX_ISOLATE_PLUGINS: 'false',
      }
      const exit = (cmd: string[], cwd: string) =>
        Bun.spawn(cmd, { cwd, env, stdout: 'ignore', stderr: 'ignore' }).exited
      const codes: Record<string, { nx: number; vx: number }> = {}
      for (const [t, yields, returns] of [
        ['return-ok', [], true],
        ['yield-ok-return-fail', [true], false],
      ] as const) {
        codes[t] = {
          nx: await exit(
            [path.join(root, 'node_modules', '.bin', 'nx'), 'run', `lib:${t}`, '--skip-nx-cache'],
            root,
          ),
          vx: await exit(
            [
              'node',
              BIN,
              './tools/outcome:gen',
              '--project',
              'lib',
              '--target',
              t,
              '--options',
              JSON.stringify({ yields, returns }),
            ],
            path.join(root, 'packages', 'lib'),
          ),
        }
      }
      expect(codes).toEqual({
        'return-ok': { nx: 0, vx: 0 },
        'yield-ok-return-fail': { nx: 1, vx: 1 },
      })
    },
    TIMEOUT,
  )
})
