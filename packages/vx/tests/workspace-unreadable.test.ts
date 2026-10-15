// A file the user may not read reached them as "a path vx must write is
// not writable" (a config), or as no file at all: a member's manifest at
// mode 000 dropped its project from `--all` and the run went green
// without it, and D-128's warning said it had no package.json (D-132).
// Projects now come from the lock and core reads no manifest, so a run
// names an unreadable project directory against the lock; the member
// globs' refusals are @vzn/vx-migrate's (its packages-unreadable test).
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

describe.skipIf(skipAsRoot('a workspace file this user may not read'))(
  'a workspace file this user may not read',
  () => {
    let root: string
    beforeEach(async () => {
      // Canonical: macOS's temp dir is a symlink, and vx names the real path.
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-unreadable-')))
      Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
      await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}')
      await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
      for (const p of ['a', 'b']) {
        await mkdir(path.join(root, 'packages', p), { recursive: true })
        await writeFile(path.join(root, 'packages', p, 'package.json'), `{"name":"${p}"}`)
        await writeFile(
          path.join(root, 'packages', p, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'echo ${p}' } } } }\n`,
        )
      }
      // A run reads only the lock, so each case starts locked.
      expect(Bun.spawnSync(['bun', BIN, 'lock'], { cwd: root }).exitCode).toBe(0)
    })
    afterEach(async () => {
      await chmod(path.join(root, 'packages', 'b'), 0o755)
      await rm(root, { recursive: true, force: true })
    })

    const run = async (
      locked: string,
      mode = 0o000,
      verb = ['run', 'build', '--all', '--dry', '--cache-dir', path.join(root, '.c')],
    ) => {
      if (locked !== '') await chmod(path.join(root, locked), mode)
      const proc = Bun.spawn(['bun', BIN, ...verb], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return {
        code,
        err: err.replaceAll(root + path.sep, '<root>/').trim(),
        planned: [...out.matchAll(/(\w)#build/g)].map((m) => m[1]),
      }
    }

    it('a manifest it may not read is a key input it cannot hash, not a lost project', async () => {
      const r = await run('packages/b/package.json')
      expect([r.code, r.planned]).toEqual([0, ['a', 'b']])
      expect(r.err).toContain(
        '<root>/packages/b/package.json is not readable by this user (EACCES), and vx reads it to derive a cache key',
      )
    })

    it('names a project config it may not read as a read', async () => {
      expect(await run('packages/b/vx.config.mjs', 0o000, ['lock'])).toEqual({
        code: 1,
        err: '✗ vx lock  lock not written\n\n  <root>/packages/b/vx.config.mjs: not readable by this user (EACCES)',
        planned: [],
      })
    })

    it('refuses a locked project directory it may not search, naming the lock', async () => {
      // Before, the check that a locked config still exists said "is gone —
      // run `vx lock`", and re-locking could not help.
      expect(await run('packages/b')).toEqual({
        code: 1,
        err: '✗ vx run  .vx/projects.lock.json locks packages/b, but its vx.config.mjs is not readable by this user (EACCES)',
        planned: [],
      })
    })

    it('CONTROL: every member readable plans both', async () => {
      expect(await run('')).toEqual({ code: 0, err: '', planned: ['a', 'b'] })
    })
  },
)
