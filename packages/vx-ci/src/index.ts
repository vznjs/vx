// Public API for @vzn/vx-ci — the GitHub Actions integration plugin.
//
// Usage in vx.workspace.ts:
//   import { defineWorkspace } from '@vzn/vx'
//   import { github } from '@vzn/vx-ci'
//   export default defineWorkspace({ plugins: [github()] })
//
// On a GitHub Actions runner (GITHUB_STEP_SUMMARY set) every `vx run`
// appends a job summary: verdict, stats, failures, and the per-task table.
// Anywhere else the plugin declines and costs nothing.
import { createRequire } from 'node:module'
import type { renderJobSummary as Render } from './summary.js'

export { github, type GithubPluginOptions } from './plugin.js'

/** The job summary's markdown for a run. Its module loads on first call, off every run's path. */
export function renderJobSummary(...args: Parameters<typeof Render>): string {
  const { renderJobSummary: render } = createRequire(import.meta.url)(
    './summary.js',
  ) as typeof import('./summary.js')
  return render(...args)
}

// The Checks API helpers are the plugin's own; only the transport type
// the options name is public (1.0 freezes what this file exports).
export { type FetchFn } from './checks.js'
