// `vx init`'s last line is the next thing to type. It said `vx run build
// --all` in a directory with no git work tree (the run refuses: vx keys
// inputs on git's view) and in a workspace whose packages had no scripts
// (the run refuses: no task declared, and its hint says run `vx init`).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function workspace(scripts: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-next-'))
  roots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'app', 'package.json'),
    JSON.stringify({ name: 'app', scripts }),
  )
  return root
}

function nextLine(root: string): string | undefined {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env['npm_config_user_agent']
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'init', '--dry'],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect({ code: r.exitCode, err: r.stderr.toString() }).toEqual({ code: 0, err: '' })
  return r.stdout.toString().trimEnd().split('\n').at(-1)
}

function gitInit(root: string): void {
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
}

describe('vx init — the next: line is a step that run would not refuse', () => {
  it('names git init outside a git work tree, and drops it inside one', async () => {
    const root = await workspace({ build: 'tsc' })
    expect(nextLine(root)).toBe('next: git init, then vx run build --all')
    gitInit(root)
    expect(nextLine(root)).toBe('next: vx run build --all')
  })

  it('with no scripts mapped, names declaring a task first', async () => {
    const root = await workspace({})
    expect(nextLine(root)).toBe(
      'next: git init, declare a task as the example shows, then vx run build --all',
    )
    gitInit(root)
    expect(nextLine(root)).toBe(
      'next: declare a task as the example shows, then vx run build --all',
    )
  })
})
