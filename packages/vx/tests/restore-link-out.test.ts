// A declared output directory that is now a symbolic link out of the
// project. The entry was saved while `dist` was a real directory; restoring
// it would write through the link, so the restore refuses — containment
// holds — but it refused as "internal error in app#build:
// ArchiveSecurityError: archive entry escapes destDir via a symlinked
// parent", on every run, since the link is no input and the key never moves
// (upstream survey, nx#37061). It is the user's tree, not the artifact, so
// it is a user error that names the link and where it leads. Replacing the
// link with a real directory is what nx#37061 reports as the bug: the link
// is the user's, and it stays.

import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

describe('restoring into an output directory that links out of the project', () => {
  let root: string
  let outside: string
  beforeEach(async () => {
    // Canonical roots: the message names real paths.
    root = await realpath(await makeWorkspace({ prefix: 'vx-link-out-' }))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-link-out-target-')))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it(
    'is refused by name, the link kept and nothing written through it',
    async () => {
      const appDir = await addProject(root, 'app', {
        files: { 'src/x.txt': 'x', '.gitignore': 'dist\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist && cat src/x.txt > dist/o.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)

      const dist = path.join(appDir, 'dist')
      await rm(dist, { recursive: true })
      await symlink(outside, dist)
      for (let i = 0; i < 2; i++) {
        const r = await vx(root, ['run', 'build', '--all'])
        expect(r.code).toBe(1)
        expect(r.out).not.toContain('internal error')
        expect(r.out).toContain(
          `[vx] app#build: ${dist} is a symbolic link to ${outside}, outside ${appDir} — ` +
            'a cache restore never writes through a link that leaves its directory. ' +
            'Remove the link and re-run (the restore puts a real directory there), ' +
            'or stop declaring outputs under it.',
        )
        expect(lstatSync(dist).isSymbolicLink()).toBe(true)
        expect(existsSync(path.join(outside, 'o.txt'))).toBe(false)
      }

      // CONTROL: a link that stays inside the project is written through.
      const inside = path.join(appDir, 'real-out')
      await mkdir(inside)
      await rm(dist)
      await symlink(inside, dist)
      const ok = await vx(root, ['run', 'build', '--all'])
      expect(ok.code).toBe(0)
      expect(await Bun.file(path.join(inside, 'o.txt')).text()).toBe('x')
      expect(lstatSync(dist).isSymbolicLink()).toBe(true)
    },
    TIMEOUT,
  )
})
