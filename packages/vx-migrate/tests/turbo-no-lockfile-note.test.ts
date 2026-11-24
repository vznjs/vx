// A Turbo repo with no lockfile, migrated `--no-install`: the workspace file
// declares no lockfile plugin, so the `^build` written has no project edges
// and the `vx lock` the report names refused it, with no word in the report
// (the scripts mapper already said so; 2026-11-23).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function turboRepo(lockfile?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-turbo-nolock-'))
  roots.push(root)
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}\n')
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
  )
  for (const [name, deps] of [
    ['a', { b: 'workspace:*' }],
    ['b', {}],
  ] as const) {
    await mkdir(path.join(root, 'packages', name), { recursive: true })
    await writeFile(
      path.join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name, dependencies: deps, scripts: { build: 'tsc' } }),
    )
  }
  if (lockfile !== undefined) await writeFile(path.join(root, lockfile), '{}\n')
  return root
}

async function migrate(root: string): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(
    [process.execPath, '--no-install', BIN, '--native', '--no-install', '--dry'],
    { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out: out.replace(/\s+/g, ' '), err, code }
}

const NOTE = '`^build` has no project edges: install with the package manager'

it('a Turbo repo with no lockfile plugin is told what gives `^build` its edges', async () => {
  const r = await migrate(await turboRepo())
  expect([r.code, r.err]).toEqual([0, ''])
  expect(r.out).toContain("dependsOn: ['^build']")
  expect(r.out).toContain(NOTE)
})

it('names each project as vx does with no lockfile plugin: by its path', async () => {
  const root = await turboRepo()
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { dependsOn: ['^build'], env: ['NEXT_PUBLIC_*'] } } }),
  )
  const r = await migrate(root)
  expect(r.out).toContain('packages/a#build, packages/b#build: env "NEXT_PUBLIC_*"')
})

it('says nothing of it once the lockfile names its plugin', async () => {
  const r = await migrate(await turboRepo('bun.lock'))
  expect([r.code, r.err]).toEqual([0, ''])
  expect(r.out).toContain('bun()')
  expect(r.out).not.toContain(NOTE)
})
