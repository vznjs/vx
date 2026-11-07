// `--keep` writes `.vx/workspace.ts` and `.vx/.gitignore` itself, not
// through core's seam: a plain write followed a link the repo carries
// and wrote outside it, a dangling `.vx/.gitignore` included, which an
// exists check reads as absent. Refused, as the seam and `vx init` refuse.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function turboRepo(): Promise<{ base: string; root: string; out: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vx-keep-nofollow-'))
  const root = path.join(base, 'repo')
  const out = path.join(base, 'out')
  await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
  await mkdir(out)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
  await writeFile(
    path.join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: 'lib', scripts: { build: 'tsc' } }),
  )
  await mkdir(path.join(root, '.vx'))
  return { base, root, out }
}

async function migrate(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, '--no-install', ...args], {
    cwd: root,
    env: { ...process.env, HOME: path.join(root, '..', 'home'), NO_COLOR: '1' },
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

describe('--keep writes through no link', () => {
  it(
    'a dangling .vx/.gitignore link is refused, and nothing is written',
    async () => {
      const { base, root, out } = await turboRepo()
      try {
        await symlink(path.join(out, 'evil'), path.join(root, '.vx', '.gitignore'))
        const r = await migrate(root, ['--keep'])
        expect([
          r.code,
          r.err.includes('.gitignore: it is a symlink'),
          existsSync(path.join(out, 'evil')),
          existsSync(path.join(root, '.vx', 'workspace.ts')),
        ]).toEqual([1, true, false, false])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a .vx/workspace.ts linked outside is refused under --force, its target untouched',
    async () => {
      const { base, root, out } = await turboRepo()
      try {
        const target = path.join(out, 'workspace.ts')
        await writeFile(target, 'outside\n')
        await symlink(target, path.join(root, '.vx', 'workspace.ts'))
        const r = await migrate(root, ['--keep', '--force'])
        expect([
          r.code,
          r.err.includes('workspace.ts: it is a symlink'),
          readFileSync(target, 'utf8'),
          existsSync(path.join(root, '.vx', '.gitignore')),
        ]).toEqual([1, true, 'outside\n', false])
        // CONTROL: no link, the same run writes both.
        await rm(path.join(root, '.vx'), { recursive: true })
        const ok = await migrate(root, ['--keep', '--force'])
        expect([
          ok.code,
          existsSync(path.join(root, '.vx', 'workspace.ts')),
          existsSync(path.join(root, '.vx', '.gitignore')),
        ]).toEqual([0, true, true])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'native after --keep drops turbo() from no linked workspace file',
    async () => {
      const { base, root, out } = await turboRepo()
      try {
        const target = path.join(out, 'workspace.ts')
        const kept =
          "import { turbo } from '@vzn/vx-migrate'\n\nexport default { plugins: [turbo()] }\n"
        await writeFile(target, kept)
        await symlink(target, path.join(root, '.vx', 'workspace.ts'))
        const r = await migrate(root, ['--native'])
        expect([
          r.code,
          r.err.includes('workspace.ts: it is a symlink'),
          readFileSync(target, 'utf8'),
        ]).toEqual([1, true, kept])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
