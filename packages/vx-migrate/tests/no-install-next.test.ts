import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// vercel/ai (Growth parity 2026-10-14): `--no-install` skips the lock step,
// yet `next:` named only `vx run build --all`, which stops with
// "no lock: run `vx lock`".
describe('vx-migrate --no-install', () => {
  let root: string
  let out: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-no-install-next-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true }),
    )
    await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } } }),
    )
    await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: 'a', scripts: { build: 'echo a' } }),
    )
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    const proc = Bun.spawn([process.execPath, BIN, '--native', '--no-install'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    out = await new Response(proc.stdout).text()
    await proc.exited
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names `vx lock` in the next line, since no lock was written', () => {
    const next = out.split('\n').find((l) => l.startsWith('  next '))
    expect(next).toBeDefined()
    expect(next).toContain('vx lock')
  })
})
