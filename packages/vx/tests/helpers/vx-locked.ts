// The CLI as a user drives it since a run reads configs only from the lock
// (owner, 2026-10-14): `vx lock`, then the verb. A test that spawns `vx run`
// or `vx watch` over configs it just wrote spawns this instead. A lock that
// fails prints why and leaves no lock behind, so the run then refuses.
import { rmSync } from 'node:fs'
import path from 'node:path'
import { findWorkspaceRoot, lockfilePath } from '../../src/workspace/index.js'

const BIN = path.join(import.meta.dir, '..', '..', 'src', 'bin.ts')
const args = process.argv.slice(2)
const root =
  (args[0] === 'run' || args[0] === 'watch') && !args.includes('--help') && !args.includes('-h')
    ? await findWorkspaceRoot(process.cwd()).catch(() => null)
    : null
if (root !== null) {
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  if (lock.exitCode !== 0) {
    process.stderr.write(lock.stderr)
    rmSync(lockfilePath(root), { force: true })
  }
}
await import(BIN)
