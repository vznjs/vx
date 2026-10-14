// `run.frozen` for `vx run` and `vx watch`: the flag, then VX_RUN_FROZEN,
// then vx.workspace, else on when CI is set (owner, 2026-10-13). A frozen
// run with no lock writes one first, which checks the graph rules, so a
// pipeline needs no `vx lock` step of its own.

import path from 'node:path'
import { notePrintedByLock } from '../orchestrator/index.js'
import { resolveSetting, settingEnv } from '../settings.js'
import { findWorkspaceRoot, LOCKFILE_NAME } from '../workspace/index.js'
import { lockWorkspace } from './lock.js'
import { loadCliWorkspace } from './workspace-config.js'

/** Whether the run is frozen, or the exit code of a lock it had to write and could not. */
export async function settleFrozen(
  cwd: string,
  flag: boolean | undefined,
): Promise<boolean | number> {
  // Settled off by the flag or the variable, the run walks to its root
  // once, as an unfrozen run always did.
  let frozen = flag ?? (settingEnv('run.frozen') as boolean | undefined)
  if (frozen === false) return false
  let root: string
  try {
    root = await findWorkspaceRoot(cwd)
  } catch {
    // No workspace: the run's own load says so.
    return frozen === true
  }
  if (frozen === undefined) {
    const { workspaceConfig } = await loadCliWorkspace(root)
    frozen =
      (resolveSetting('run.frozen', workspaceConfig).value as boolean | undefined) ??
      onCI(process.env['CI'])
  }
  // A stat: the run reads the lock itself, once.
  if (!frozen || (await Bun.file(path.join(root, LOCKFILE_NAME)).exists())) return frozen
  const printed: string[] = []
  const code = await lockWorkspace(root, undefined, (message) => {
    process.stderr.write(`${message}\n`)
    printed.push(message)
  })
  if (code !== 0) return code
  notePrintedByLock(printed)
  return true
}

/** CI=0 and CI=false are "not CI": several vendors set CI=true. */
export function onCI(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}
