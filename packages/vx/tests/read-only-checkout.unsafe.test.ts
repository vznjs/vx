// A checkout mounted read-only (a container's source mount, a Nix store
// path): `status` reads a refreshed copy of the index kept beside it when
// an entry is racily clean (git-inputs.ts `refreshedIndex`). The copy
// cannot be written there, and its cleanup's `rm` threw EROFS out of the
// fallback: the run died as "unhandled rejection". Bubblewrap mounts the
// checkout read-only with no privilege, so root is held to it too. Unsafe:
// bwrap cannot nest in a sandboxed shard. Without bwrap it skips, except
// where VX_REQUIRE_SANDBOX (CI) makes that a failure.
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { BIN } from './helpers/vx.js'

const BWRAP = Bun.which('bwrap')
const TIMEOUT = 30_000

let root: string | undefined
let cache: string | undefined
afterEach(async () => {
  for (const d of [root, cache]) if (d) await rm(d, { recursive: true, force: true })
  root = cache = undefined
})

describe.skipIf(
  process.platform !== 'linux' || (BWRAP === null && process.env['VX_REQUIRE_SANDBOX'] !== '1'),
)('a read-only checkout', () => {
  it(
    'runs from the real index when the refreshed copy cannot be written beside it',
    async () => {
      expect(BWRAP).not.toBeNull()
      const r = (root = await makeWorkspace({ prefix: 'vx-ro-checkout-' }))
      cache = await mkdtemp(path.join(os.tmpdir(), 'vx-ro-cache-'))
      await addProject(r, 'app', {
        config: `export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n`,
        files: { 'src/index.js': 'export {}\n' },
      })
      // Racily clean: an mtime before the index's second, a ctime in it.
      const old = new Date(Date.now() - 3_600_000)
      await utimes(path.join(r, 'packages/app/src/index.js'), old, old)
      const git = gitIn(r)
      expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: r }).exitCode).toBe(0)
      git('add', '-A')
      git('commit', '-qm', 'init')
      const p = Bun.spawnSync({
        cmd: [
          BWRAP!,
          ...['--bind', '/', '/', '--dev', '/dev', '--proc', '/proc'],
          ...['--ro-bind', r, r, '--chdir', r],
          ...[process.execPath, BIN, 'run', 'build', '--all'],
        ],
        env: { ...process.env, VX_CACHE_DIR: cache, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(p.stderr.toString()).not.toContain('EROFS')
      expect(p.exitCode).toBe(0)
      expect(git('status', '--porcelain')).toBe('')
    },
    TIMEOUT,
  )
})
