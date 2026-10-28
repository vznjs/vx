// The orchestrator as a caller drives it since a run reads configs only from
// the lock (2026-10-14): `run`, `planRun` and `prepareRun` here lock the workspace
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

// Locks run concurrently (abort.test.ts runs two runs at once), so the env
// and the muted streams are set by the first lock in and restored by the
// last one out: one restoring mid-way changed the env under another's
// config evaluation, which vx refuses.
let active = 0
let saved: {
  env: string | undefined
  out: typeof process.stdout.write
  err: typeof process.stderr.write
}
const listeners = new Set<string[]>()

/**
 * Writes the lock for the workspace `cwd` is in; a refusal throws its line.
 * `warn` gets what `vx lock` warns (a plugin's mapping gaps).
 */
export async function lock(cwd: string, warn: (line: string) => void = () => {}): Promise<void> {
  const root = await findWorkspaceRoot(cwd)
  const said: string[] = []
  if (active++ === 0) {
    saved = {
      env: process.env['VX_LOCK_REVIEW_FILES'],
      out: process.stdout.write,
      err: process.stderr.write,
    }
    process.env['VX_LOCK_REVIEW_FILES'] = 'false'
    process.stdout.write = () => true
    process.stderr.write = (chunk: string | Uint8Array) => {
      for (const l of listeners) l.push(String(chunk))
      return true
    }
  }
  listeners.add(said)
  try {
    const code = await lockWorkspace(root, warn)
    if (code !== 0) throw new Error(said.join('').trim())
  } finally {
    listeners.delete(said)
    if (--active === 0) {
      process.stdout.write = saved.out
      process.stderr.write = saved.err
      if (saved.env === undefined) delete process.env['VX_LOCK_REVIEW_FILES']
      else process.env['VX_LOCK_REVIEW_FILES'] = saved.env
    }
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
