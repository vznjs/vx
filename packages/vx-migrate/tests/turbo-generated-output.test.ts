// A codegen task that writes a committed file it names as an output
// (`outputs: ["src/generated.ts"]`): the tracked pass took the file back
// with `!`, so it stayed an input, and core withholds the save of a task
// that rewrites its own input. It ran on every run and never hit.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({ tasks: { codegen: { outputs: ['src/generated.ts'] } } })

describe('turbo(): a committed file an output names literally', () => {
  it('is an output: the codegen that rewrites it saves and hits', async () => {
    const lib = path.join(ws.root, 'packages', 'lib')
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        scripts: { codegen: 'cat src/index.js > src/generated.ts' },
      }),
    )
    await writeFile(path.join(lib, 'src', 'generated.ts'), '// lib\n')
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
    const codegen = async () => {
      const log = silent()
      const r = await run({ cwd: ws.root, tasks: ['lib#codegen'], log, handleSignals: false })
      return {
        ok: r.ok,
        status: r.outcomes.find((o) => o.node.id === 'lib#codegen')?.status,
        lines: log.lines.filter((l) => l.startsWith('[vx]')),
      }
    }
    expect((await codegen()).status).toBe('success')
    expect(await codegen()).toEqual({ ok: true, status: 'cache-hit', lines: [] })
    expect(await Bun.file(path.join(lib, 'src', 'generated.ts')).text()).toBe('// lib\n')
  }, 30_000)
})
