// `//` is Turbo's name for the root project, and `vx show //#task` read it
// so; `vx show //` alone was refused with a suggestion of other projects.
// Where the root is no project, both now say so instead of "unknown
// project".
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function workspace(rootConfig: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-root-'))
  roots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'top', private: true }))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  if (rootConfig) {
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { check: { exec: { command: 'true' } } } }\n`,
    )
  }
  return root
}

function show(cwd: string, target: string): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'show', target],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('vx show //', () => {
  it('shows the root project, as `//#task` shows its task', async () => {
    const root = await workspace(true)
    const check = 'check\n  command: true\n'
    // The project lists its default build too (a group keyed on its files).
    const build =
      'build\n  command:       (group)\n  dependsOn:     ^build\n  inputs.files:  **\n  outputs.files: \n'
    expect([show(root, '//'), show(root, '//#check')]).toEqual([
      { code: 0, out: `top — .\n\n${check}\n${build}`, err: '' },
      { code: 0, out: `top — .\n\n${check}`, err: '' },
    ])
  })

  it('says the root is no project where it is none', async () => {
    const root = await workspace(false)
    expect([show(root, '//'), show(root, '//#check')]).toEqual([
      {
        code: 1,
        out: '',
        err: 'vx show: "//" names the workspace root\'s project, and the root is no project here\n',
      },
      {
        code: 1,
        out: '',
        err: 'vx show: "//#check" names the workspace root\'s project, and the root is no project here\n',
      },
    ])
  })
})
