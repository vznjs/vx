// A run's run-level settings, resolved once before any task: the flag
// (a RunOptions field) beats its variable, which beats `.vx/workspace`
// (src/settings.ts). A task's own `exec.timeout` / `exec.retries` is
// applied where the task runs, above all three.

import type { WorkspaceConfig } from '../config.js'
import { resolveSetting } from '../settings.js'
import { setSettleBounds, type SettleBound } from '../util/index.js'
import type { RunOptions } from './options.js'

const FROM_OPTIONS = {
  concurrency: 'run.concurrency',
  schedule: 'run.schedule',
  timeout: 'run.timeout',
  retries: 'run.retries',
  continueMode: 'run.continue',
  readyNotice: 'run.readyNotice',
  download: 'cache.download',
} as const satisfies Partial<Record<keyof RunOptions, string>>

/**
 * `options` with each run-level setting it leaves unset filled from the
 * environment, then the workspace. Arms the settle bounds (`util/settle`,
 * below settings) with the flag's or workspace's `run.killGrace` and
 * `run.teardownTimeout`: the variable sits between them, read per call.
 */
export function withRunSettings(
  options: RunOptions,
  workspace: WorkspaceConfig | null | undefined,
): RunOptions {
  const out: Record<string, unknown> = { ...options }
  for (const [field, path] of Object.entries(FROM_OPTIONS)) {
    const { value } = resolveSetting(path, workspace, options[field as keyof RunOptions])
    if (value !== undefined) out[field] = value
  }
  const bound = (flag: number | undefined, path: string): SettleBound | undefined => {
    if (flag !== undefined) return { ms: flag, from: 'flag' }
    const { value } = resolveSetting(path, workspace, undefined, {})
    return value === undefined ? undefined : { ms: value as number, from: 'workspace' }
  }
  const killGrace = bound(options.killGrace, 'run.killGrace')
  const teardown = bound(options.teardownTimeout, 'run.teardownTimeout')
  setSettleBounds({
    ...(killGrace !== undefined ? { killGrace } : {}),
    ...(teardown !== undefined ? { teardown } : {}),
  })
  return out as unknown as RunOptions
}
