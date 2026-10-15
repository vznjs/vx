// A run's run-level settings, resolved once before any task: the flag
// (a RunOptions field) beats its variable, which beats `.vx/workspace`
// (src/settings.ts). A task's own `exec.timeout` / `exec.retries` is
// applied where the task runs, above all three.

import type { WorkspaceConfig } from '../config.js'
import { resolveSetting } from '../settings.js'
import type { RunOptions } from './options.js'

const FROM_OPTIONS = {
  concurrency: 'run.concurrency',
  schedule: 'run.schedule',
  timeout: 'run.timeout',
  retries: 'run.retries',
  continueMode: 'run.continue',
  download: 'cache.download',
} as const satisfies Partial<Record<keyof RunOptions, string>>

/**
 * `options` with each run-level setting it leaves unset filled from the
 * environment, then the workspace.
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
  return out as unknown as RunOptions
}
