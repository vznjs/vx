// The orchestrator as a caller drives it since a run reads configs only from
// the lock (2026-10-14): `run`, `planRun` and `prepareRun` here lock the workspace
// first, in process and silently, as `vx lock` would. Everything else is
// the module's own.
import { lockWorkspace } from '../../src/cli/lock.js'
import {
  planCore as corePlanRun,
  prepareRun as corePrepareRun,
  runCore as coreRun,
  type CoreRunOptions,
} from '../../src/orchestrator/index.js'
import { findWorkspaceRoot } from '../../src/workspace/index.js'

export * from '../../src/orchestrator/index.js'

// Locks run concurrently (abort.test.ts runs two runs at once), so the
// muted streams are set by the first lock in and restored by the last one
// out. The env is held longer, until the last run is out too: a run with no
// stamps beside its lock evaluates every config, and one lock ending put the
// env back under a run already evaluating, which vx refuses as a config's
// edit (vx-cache's shared-cache race).
let active = 0
let saved: {
  out: typeof process.stdout.write
  err: typeof process.stderr.write
}
let holding = 0
let savedEnv: string | undefined
const listeners = new Set<string[]>()

async function holdingEnv<T>(body: () => Promise<T>): Promise<T> {
  if (holding++ === 0) {
    savedEnv = process.env['VX_LOCK_REVIEW_FILES']
    process.env['VX_LOCK_REVIEW_FILES'] = 'false'
  }
  try {
    return await body()
  } finally {
    if (--holding === 0) {
      if (savedEnv === undefined) delete process.env['VX_LOCK_REVIEW_FILES']
      else process.env['VX_LOCK_REVIEW_FILES'] = savedEnv
    }
  }
}

/**
 * Writes the lock for the workspace `cwd` is in; a refusal throws its line.
 * `warn` gets what `vx lock` warns (a plugin's mapping gaps).
 */
export function lock(cwd: string, warn: (line: string) => void = () => {}): Promise<void> {
  return holdingEnv(() => lockMuted(cwd, warn))
}

async function lockMuted(cwd: string, warn: (line: string) => void): Promise<void> {
  const root = await findWorkspaceRoot(cwd)
  const said: string[] = []
  if (active++ === 0) {
    saved = { out: process.stdout.write, err: process.stderr.write }
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
    }
  }
}

export function run(options: CoreRunOptions): ReturnType<typeof coreRun> {
  return holdingEnv(async () => {
    await lock(options.cwd)
    return coreRun(options)
  })
}

export function planRun(...args: Parameters<typeof corePlanRun>): ReturnType<typeof corePlanRun> {
  return holdingEnv(async () => {
    await lock(args[0].cwd)
    return corePlanRun(...args)
  })
}

export function prepareRun(
  ...args: Parameters<typeof corePrepareRun>
): ReturnType<typeof corePrepareRun> {
  return holdingEnv(async () => {
    await lock(args[0].cwd)
    return corePrepareRun(...args)
  })
}
