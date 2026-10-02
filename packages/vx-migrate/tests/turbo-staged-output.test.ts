// G-148: the kept turbo() mapping keyed on HEAD and its reflog, not the
// index, so a file `git add`ed under an output and not yet committed was
// not taken back from the output, and the next run's clean deleted it.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({ tasks: { build: { outputs: ['data/**'] } } })

describe('turbo(): a file staged under an output', () => {
  it('survives the next run', async () => {
    const lib = path.join(ws.root, 'packages', 'lib')
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        scripts: { build: 'echo gen > data/gen.txt' },
      }),
    )
    await mkdir(path.join(lib, 'data'))
    await writeFile(path.join(lib, 'data', 'committed.json'), '{}\n')
    const git = (...args: string[]) =>
      Bun.spawnSync({
        cmd: [
          'git',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          ...args,
        ],
        cwd: ws.root,
      })
    git('add', '-A')
    expect(git('commit', '-qm', 'init').exitCode).toBe(0)
    const build = () =>
      run({ cwd: ws.root, tasks: ['lib#build'], log: silent(), handleSignals: false })
    expect((await build()).ok).toBe(true)
    await writeFile(path.join(lib, 'data', 'staged.json'), '{}\n')
    git('add', 'packages/lib/data/staged.json')
    expect((await build()).ok).toBe(true)
    expect(await Bun.file(path.join(lib, 'data', 'staged.json')).exists()).toBe(true)
  }, 30_000)
})
