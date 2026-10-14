// The CLI dispatcher as a user drives it since a run reads configs only from
// the lock (owner, 2026-10-14): `vx run` and `vx watch` lock first. A lock
// that fails prints why and leaves no lock behind, so the run then refuses.
import { rmSync } from 'node:fs'
import { run as cliRun } from '../../src/cli/index.js'
import { findWorkspaceRoot, lockfilePath } from '../../src/workspace/index.js'
import { lock } from './orchestrator.js'

export * from '../../src/cli/index.js'

export async function run(argv: readonly string[]): Promise<number> {
  const root =
    (argv[0] === 'run' || argv[0] === 'watch') && !argv.includes('--help') && !argv.includes('-h')
      ? await findWorkspaceRoot(process.cwd()).catch(() => null)
      : null
  if (root !== null) {
    await lock(root).catch((err: Error) => {
      process.stderr.write(`${err.message}\n`)
      rmSync(lockfilePath(root), { force: true })
    })
  }
  return cliRun(argv)
}
