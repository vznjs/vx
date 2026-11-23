// The CLI as a user drives it since a run reads configs only from the lock
// (2026-10-14): `vx lock`, then the verb. A test that spawns `vx run`,
// `watch`, `show` or `info` over configs it just wrote spawns this instead. A lock that
// fails prints why and leaves no lock behind, so the run then refuses.
//
// The audit runs in this process, not a `vx lock --check` child: the child
// booted the CLI's modules only to answer yes or no, ~175 ms of each call's
// ~390, and the verb loads the same modules again here. With no lock there is
// nothing to audit. A lock written meanwhile leaves this process holding what
// the audit read, so the verb then starts in a fresh image (same pid, so a
// test's signal still reaches it).
import { existsSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { findWorkspaceRoot, lockfilePath } from '../../src/workspace/index.js'

const BIN = path.join(import.meta.dir, '..', '..', 'src', 'bin.ts')
const args = process.argv.slice(2)
const root =
  ['run', 'watch', 'pipeline', 'show', 'info'].includes(args[0] ?? '') &&
  !args.includes('--help') &&
  !args.includes('-h')
    ? await findWorkspaceRoot(process.cwd()).catch(() => null)
    : null
const REVIEW_OFF = { VX_LOCK_REVIEW_FILES: 'false' }

// An up-to-date lock is left alone: a test of a full disk or a read-only
// tree must reach the verb, not a lock write the user would not make.
async function current(): Promise<boolean> {
  const { registerCoreAlias } = await import('../../src/cli/index.js')
  registerCoreAlias(
    () => require('../../src/index.js') as Record<string, unknown>,
    () => require('../../src/config.js') as Record<string, unknown>,
  )
  const { lockCmd } = await import('../../src/cli/lock.js')
  const { stdout, stderr } = process
  const [out, err] = [stdout.write, stderr.write]
  const was = process.env['VX_LOCK_REVIEW_FILES']
  stdout.write = (() => true) as typeof out
  stderr.write = (() => true) as typeof err
  Object.assign(process.env, REVIEW_OFF)
  try {
    return (await lockCmd(['--check'])) === 0
  } catch {
    return false
  } finally {
    stdout.write = out
    stderr.write = err
    if (was === undefined) delete process.env['VX_LOCK_REVIEW_FILES']
    else process.env['VX_LOCK_REVIEW_FILES'] = was
  }
}

const audited = root !== null && existsSync(lockfilePath(root))
if (root !== null && !(audited && (await current()))) {
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, ...REVIEW_OFF },
  })
  if (lock.exitCode !== 0) {
    writeSync(2, lock.stderr)
    rmSync(lockfilePath(root), { force: true })
  }
  if (audited) process.execve(process.execPath, [process.execPath, BIN, ...args], process.env)
}
await import(BIN)
