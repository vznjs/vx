// `{args.name}` takes a value passed after `vx run … --` before the
// options' own, as `nx run app:deploy --env=prod` fills it. vx filled it
// from the options alone, so the forwarded value never reached the
// command. Held to real `nx run` on the same options and arguments;
// skips without `VX_NX_MODULES` (see nx-exec-live.test.ts).
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

const OPTIONS = {
  command: `printf '%s|' [{args.region}] [{args.r}] [{args.flag}] [{args.x}] [{args.tag}] > a.txt`,
  region: 'eu',
  args: '--tag=t',
}
const ROWS: [string, string[]][] = [
  ['nothing forwarded: the options and `args`', []],
  ['--name=value and --name value', ['--region=us', '--tag', 'u']],
  ['a repeated name, joined with a comma', ['--region=a', '--region=b']],
  ['a one-letter -n value', ['-r', 'us']],
  ['--name alone is true, --no-name false', ['--flag', '--no-region']],
  ['a flag before a flag is true; a negative number is a value', ['--x', '--flag', '--tag', '-1']],
  ['a bare -- stops nothing', ['--', '--region=us']],
  ['a value with a space splits as Nx splices it', ['--region=a b']],
]

let root: string

describe.skipIf(!MODULES)('{args.name} takes the forwarded value, as nx run does', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-args-name-'))
    await symlink(path.join(MODULES!, 'node_modules'), path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'package.json'), '{"name":"live","private":true}')
    await writeFile(path.join(root, 'nx.json'), '{}')
    await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'lib', 'project.json'),
      JSON.stringify({
        name: 'lib',
        targets: { go: { executor: 'nx:run-commands', options: OPTIONS } },
      }),
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function outcome(run: () => Promise<number>) {
    await rm(path.join(root, 'a.txt'), { force: true })
    const failed = (await run()) !== 0
    const file = Bun.file(path.join(root, 'a.txt'))
    return { failed, out: (await file.exists()) ? await file.text() : null }
  }

  const mapped = mapRunCommands(OPTIONS, { projectRel: 'packages/lib', projectName: 'lib' }, [])!

  for (const [title, args] of ROWS) {
    it(
      title,
      async () => {
        const nx = await outcome(
          () =>
            Bun.spawn(
              [
                'node',
                path.join(root, 'node_modules', '.bin', 'nx'),
                'run',
                'lib:go',
                ...args,
                '--skip-nx-cache',
              ],
              {
                cwd: root,
                env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
              },
            ).exited,
        )
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
        expect(nx.out).not.toBeNull()
        expect(vx).toEqual(nx)
      },
      TIMEOUT,
    )
  }
})
