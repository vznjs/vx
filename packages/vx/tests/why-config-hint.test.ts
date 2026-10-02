// `vx why` on a changed config printed only two digests and a hint with
// no next step; the hint now names the `vx show` that prints the config.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

function vx(cwd: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

const config = (cmd: string): string =>
  `export default { tasks: { build: { exec: { command: '${cmd}' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n`

describe('vx why — a config change', () => {
  it('names the vx show that prints the task config', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-why-config-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const dir = path.join(root, 'packages', 'app')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(dir, 'src', 'x.ts'), 'x\n')
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
    await writeFile(path.join(dir, 'vx.config.mjs'), config('true'))
    expect(vx(root, 'run', 'build', '--all').code).toBe(0)
    await writeFile(path.join(dir, 'vx.config.mjs'), config('true && true'))
    expect(vx(root, 'run', 'build', '--all').code).toBe(0)
    const r = vx(root, 'why', 'app#build')
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(r.out.split('\n').filter((l) => l.startsWith('    config  '))).toEqual([
      "    config  the task's evaluated config changed (its vx.config or a file it imports); `vx show app#build` prints it as it is now",
    ])
  })
})
