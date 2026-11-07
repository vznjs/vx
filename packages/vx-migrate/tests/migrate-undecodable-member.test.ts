// A member directory whose name is not valid UTF-8 reads as no member: no
// string path names it, so its package.json is never found. The note said
// the globs match no package.json, and named nothing to rename.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function migrate(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, '--no-install', ...args], {
    cwd: root,
    env: { ...process.env, HOME: path.join(root, 'home'), NO_COLOR: '1' },
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

describe('a member whose directory name is not UTF-8', () => {
  for (const glob of ['packages/*', 'packages/{x*,y}']) {
    it(
      `is named, escaped, by the note (${glob})`,
      async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'vx-undecodable-'))
        try {
          await writeFile(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'r', private: true, workspaces: [glob] }),
          )
          // No string path names it: `x` + byte 0xff.
          const bad = Buffer.concat([Buffer.from(`${root}/packages/x`), Buffer.from([0xff])])
          await mkdir(path.join(root, 'packages'))
          await mkdir(bad)
          await writeFile(
            Buffer.concat([bad, Buffer.from('/package.json')]),
            JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
          )
          const r = await migrate(root, ['--dry'])
          expect([r.code, r.out.includes('match no package.json')]).toEqual([0, false])
          expect(r.out).toContain(
            "packages/x\\xff: the directory's name is not valid UTF-8, so its package.json cannot be read — rename it",
          )
          // CONTROL: renamed, it is a member.
          await rm(bad, { recursive: true })
          await mkdir(path.join(root, 'packages', 'x'))
          await writeFile(
            path.join(root, 'packages', 'x', 'package.json'),
            JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
          )
          const ok = await migrate(root, ['--dry'])
          expect([ok.code, ok.out.includes('not valid UTF-8'), ok.out]).toEqual([
            0,
            false,
            expect.stringContaining('packages/x/vx.config.ts'),
          ])
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }
})
