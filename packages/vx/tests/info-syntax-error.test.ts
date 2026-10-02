// `vx info` names a config that did not load once, workspace-relative. A
// syntax error's message carries `:line:col` after the absolute path, which
// the prefix strip missed, so the row named the file twice.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('vx info — a config with a syntax error', () => {
  it('names the file once, then the line and column', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-info-syntax-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(path.join(dir, 'vx.config.mjs'), 'export default {\n')
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'info', '--format', 'json'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect({ code: r.exitCode, err: r.stderr.toString() }).toEqual({ code: 0, err: '' })
    const errors = (JSON.parse(r.stdout.toString()) as { configErrors: unknown }).configErrors
    expect(errors).toEqual([
      { path: 'packages/a/vx.config.mjs', message: expect.stringMatching(/^\d+:\d+: \S/) },
    ])
    expect(JSON.stringify(errors)).not.toContain(root)
  })
})
