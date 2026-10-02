// Every `vx show` refusal names the verb, as `vx why:`, `vx info:` and
// `vx show: missing task name …` do; three said only `vx:`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

describe('vx show — a refusal names the verb', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-err-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const dir = path.join(root, 'packages', 'app')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const show = (target: string): { code: number | null; err: string } => {
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'show', target],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: r.exitCode, err: r.stderr.toString() }
  }

  it('unknown project, unknown task, unknown project-or-task', () => {
    expect([show('zzz#build'), show('app#zzz'), show('zzzzzz')]).toEqual([
      { code: 1, err: 'vx show: unknown project: "zzz"\n' },
      { code: 1, err: 'vx show: unknown task: "app#zzz"\n' },
      { code: 1, err: 'vx show: unknown project or task: "zzzzzz"\n' },
    ])
  })
})
