// The orchestrator as a caller drives it since a run reads configs only from
// the lock (owner, 2026-10-14): `run`, `planRun` and `prepareRun` here lock the workspace
// first, in process and silently, as `vx lock` would. Everything else is
// the module's own.
import { lockWorkspace } from '../../src/cli/lock.js'
import {
  planRun as corePlanRun,
  prepareRun as corePrepareRun,
  run as coreRun,
  type RunOptions,
} from '../../src/orchestrator/index.js'
import { findWorkspaceRoot } from '../../src/workspace/index.js'

export * from '../../src/orchestrator/index.js'

/** Writes the lock for the workspace `cwd` is in; a refusal throws its line. */
export async function lock(cwd: string): Promise<void> {
  const root = await findWorkspaceRoot(cwd)
  const out = process.stdout.write
  const err = process.stderr.write
  const said: string[] = []
  const env = process.env['VX_LOCK_REVIEW_FILES']
  process.env['VX_LOCK_REVIEW_FILES'] = 'false'
  process.stdout.write = () => true
  process.stderr.write = (chunk: string | Uint8Array) => {
    said.push(String(chunk))
    return true
  }
  try {
    const code = await lockWorkspace(root, undefined, () => {})
    if (code !== 0) throw new Error(said.join('').trim())
  } finally {
    process.stdout.write = out
    process.stderr.write = err
    if (env === undefined) delete process.env['VX_LOCK_REVIEW_FILES']
    else process.env['VX_LOCK_REVIEW_FILES'] = env
  }
}

export async function run(options: RunOptions): ReturnType<typeof coreRun> {
  await lock(options.cwd)
  return coreRun(options)
}

export async function planRun(
  ...args: Parameters<typeof corePlanRun>
): ReturnType<typeof corePlanRun> {
  await lock(args[0].cwd)
  return corePlanRun(...args)
}

export async function prepareRun(
  ...args: Parameters<typeof corePrepareRun>
): ReturnType<typeof corePrepareRun> {
  await lock(args[0].cwd)
  return corePrepareRun(...args)
}
