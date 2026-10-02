// A forwarded argument replaces the run-commands option of its name, as
// `nx run` does (`unknownOptions` skips a key `__unparsed__` holds): vx
// baked `--region=eu` into the line, so `vx run … -- --region=us` ran the
// command with both. Held to real `nx run` on the same options and
// arguments; skips without `VX_NX_MODULES` (see nx-exec-live.test.ts).
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mapRunCommands } from '../src/nx-command.js'

const MODULES = process.env['VX_NX_MODULES']
const TIMEOUT = 120_000
if (process.env['VX_REQUIRE_NX'] === '1' && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset')
}

const put = (name: string, words: string) => `printf '%s|' ${words} > ${name}`
const ROWS: [string, Record<string, unknown>, string[]][] = [
  ['--name=value', { command: put('a.txt', 'x'), region: 'eu', mode: 'a b' }, ['--region=us']],
  ['--name value', { command: put('a.txt', 'x'), region: 'eu' }, ['--region', 'us']],
  ['--no-name', { command: put('a.txt', 'x'), region: 'eu', mode: 'm' }, ['--no-region']],
  ['a one-letter -n', { command: put('a.txt', 'x'), r: 'eu', s: 't' }, ['-r=us']],
  ['no camel-case expansion', { command: put('a.txt', 'x'), someThing: 'b' }, ['--some-thing=c']],
  [
    'each of several commands, beside `args`',
    { commands: [put('a.txt', 'x'), put('b.txt', 'y')], region: 'eu', args: '--k=1' },
    ['--region=us'],
  ],
  ['{args}', { command: put('a.txt', '[{args}]'), region: 'eu', o: 'p' }, ['--o=q']],
  ['nothing forwarded', { command: put('a.txt', '[{args}]'), region: 'eu' }, []],
]
const OUTS = ['a.txt', 'b.txt']

let root: string

describe.skipIf(!MODULES)('a forwarded argument replaces the option, as nx run does', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-rc-override-'))
    await symlink(path.join(MODULES!, 'node_modules'), path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'package.json'), '{"name":"live","private":true}')
    await writeFile(path.join(root, 'nx.json'), '{}')
    await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function outcome(run: () => Promise<number>) {
    for (const f of OUTS) await rm(path.join(root, f), { force: true })
    const code = await run()
    const files: Record<string, string> = {}
    for (const f of OUTS) {
      const file = Bun.file(path.join(root, f))
      if (await file.exists()) files[f] = await file.text()
    }
    return { failed: code !== 0, files }
  }

  for (const [title, options, args] of ROWS) {
    it(
      title,
      async () => {
        await writeFile(
          path.join(root, 'packages', 'lib', 'project.json'),
          JSON.stringify({
            name: 'lib',
            targets: { go: { executor: 'nx:run-commands', options } },
          }),
        )
        const nx = await outcome(
          () =>
            Bun.spawn(
              ['node', path.join(root, 'node_modules', '.bin', 'nx'), 'run', 'lib:go', ...args],
              {
                cwd: root,
                env: {
                  ...process.env,
                  NX_DAEMON: 'false',
                  NX_NO_CLOUD: 'true',
                  NX_SKIP_NX_CACHE: 'true',
                },
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
              },
            ).exited,
        )
        const mapped = mapRunCommands(
          options,
          { projectRel: 'packages/lib', projectName: 'lib' },
          [],
        )!
        const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ')
        const vx = await outcome(
          () =>
            Bun.spawn(['sh', '-c', `${mapped.command} ${quoted}`], {
              cwd: path.join(root, 'packages', 'lib'),
              stdin: 'ignore',
              stdout: 'ignore',
              stderr: 'ignore',
            }).exited,
        )
        expect(vx).toEqual(nx)
        expect(Object.keys(nx.files).length).toBeGreaterThan(0)
      },
      TIMEOUT,
    )
  }
})
