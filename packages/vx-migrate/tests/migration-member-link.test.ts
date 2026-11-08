// A workspace member whose directory is a link out of the workspace
// (`packages/a -> ../../out/a`) passed the seam's root guard, which reads
// the path's spelling: its vx.config.ts was written outside the root, where
// core's discovery never loads it. The guard reads the real directory.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function linkedRepo(target: (base: string, root: string) => string) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vx-member-link-'))
  const root = path.join(base, 'repo')
  await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(
    path.join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: 'lib', scripts: { build: 'tsc' } }),
  )
  const real = target(base, root)
  await mkdir(real, { recursive: true })
  await writeFile(
    path.join(real, 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
  )
  await symlink(path.relative(path.join(root, 'packages'), real), path.join(root, 'packages', 'a'))
  return { base, root, real }
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

describe('a member linked out of the workspace', () => {
  it(
    'is refused, and nothing is written in or out of the root',
    async () => {
      const { base, root, real } = await linkedRepo((b) => path.join(b, 'out', 'a'))
      try {
        const r = await migrate(root, [])
        expect([
          r.code,
          r.err.includes('packages/a/vx.config.ts: outside the workspace root'),
          // Real: macOS reaches the temp dir through /var -> /private/var.
          r.err.includes(`packages/a resolves to ${realpathSync(real)}`),
          existsSync(path.join(real, 'vx.config.ts')),
          existsSync(path.join(root, 'packages', 'lib', 'vx.config.ts')),
          existsSync(path.join(root, '.vx')),
        ]).toEqual([1, true, true, false, false, false])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'CONTROL: a link to a directory inside the root is written at its real place',
    async () => {
      const { base, root, real } = await linkedRepo((_, r) => path.join(r, 'ext', 'a'))
      try {
        const r = await migrate(root, [])
        expect([r.code, existsSync(path.join(real, 'vx.config.ts'))]).toEqual([0, true])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
