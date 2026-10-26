// A repo with package.json scripts and no Turbo, Nx or Vite Task config:
// vx-migrate maps the scripts, one vx.config.ts per package, and declares
// the lockfile plugin its lockfile calls for. `vx init` hands such a repo
// here (M, 2026-10-14: core reads no package.json).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function bunRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-scripts-'))
  roots.push(root)
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}\n')
  await writeFile(path.join(root, 'bun.lock'), '{}\n')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'a', 'package.json'),
    '{"name":"a","scripts":{"build":"tsc"}}\n',
  )
  return root
}

async function migrate(cwd: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

describe('vx-migrate on package.json scripts', () => {
  it('maps each package and declares the lockfile plugin', async () => {
    const root = await bunRepo()
    const r = await migrate(root, ['--dry', '--format', 'json'])
    expect([r.code, r.err]).toEqual([0, ''])
    const plan = JSON.parse(r.out) as {
      source: string
      files: { path: string; contents: string }[]
    }
    expect([plan.source, plan.files.map((f) => f.path)]).toEqual([
      'package.json scripts',
      ['packages/a/vx.config.ts', '.vx/workspace.ts', '.vx/.gitignore'],
    ])
    expect(plan.files[0]!.contents).toContain("command: 'tsc'")
    expect(plan.files[1]!.contents).toContain("import { bun } from '@vzn/vx-lockfile'")
  })

  it('--from scripts reads them beside a turbo.json', async () => {
    const root = await bunRepo()
    await writeFile(path.join(root, 'turbo.json'), '{"tasks":{}}\n')
    const r = await migrate(root, ['--from', 'scripts', '--dry', '--format', 'json'])
    expect([r.code, r.err, (JSON.parse(r.out) as { source: string }).source]).toEqual([
      0,
      '',
      'package.json scripts',
    ])
  })

  it('--native and --keep answer a Turbo or Nx question, and are refused', async () => {
    const root = await bunRepo()
    const r = await migrate(root, ['--keep', '--dry'])
    expect([r.code, r.err]).toEqual([
      1,
      "vx-migrate: --keep answers a Turbo or Nx repo's question, and no turbo.json or nx.json is at .\n",
    ])
  })

  // `vx init` in a Bun workspace with scripts writes an empty root project
  // and names vx-migrate; its starter was kept, and the root's scripts lost.
  it("maps over vx init's starter: the root's scripts become its tasks", async () => {
    const root = await bunRepo()
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","workspaces":["packages/*"],"scripts":{"lint":"oxlint ."}}\n',
    )
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env }).exitCode).toBe(0)
    const init = Bun.spawnSync(
      [process.execPath, path.resolve(import.meta.dir, '../../vx/src/bin.ts'), 'init'],
      { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect([init.exitCode, init.stdout.toString()]).toEqual([
      0,
      expect.stringContaining('bunx @vzn/vx-migrate to make package.json scripts tasks'),
    ])
    const r = await migrate(root, ['--no-install'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(r.out).not.toContain('kept')
    expect(await readFile(path.join(root, 'vx.config.ts'), 'utf8')).toContain("command: 'oxlint .'")
  })
})
