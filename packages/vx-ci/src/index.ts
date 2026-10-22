// Public API for @vzn/vx-ci — the GitHub Actions and GitLab CI plugins.
//
// Usage in .vx/workspace.ts:
//   import { defineWorkspace } from '@vzn/vx'
//   import { github } from '@vzn/vx-ci'
//   export default defineWorkspace({ plugins: [github()] })
//
// On a GitHub Actions runner (GITHUB_STEP_SUMMARY set) every `vx run`
// appends a job summary: verdict, stats, failures, and the per-task table.
// Anywhere else the plugin declines and costs nothing.
import { createRequire } from 'node:module'
import type { RunSummaryRecord, VxPlugin } from '@vzn/vx'
import type { GithubPluginOptions } from './plugin.js'
import type { GitlabPluginOptions } from './gitlab.js'

export type { GithubPluginOptions, GitlabPluginOptions }

// Every run evaluates `.vx/workspace.ts`, and off CI both factories
// decline: this file is all a laptop loads (five files were ~1.1 ms of
// every run). Each module loads on its own CI, by `require` as the
// factories are synchronous.
const load = createRequire(import.meta.url)

export function github(options?: GithubPluginOptions): VxPlugin | undefined {
  if (process.env['GITHUB_ACTIONS'] !== 'true') return undefined
  return (load('./plugin.js') as typeof import('./plugin.js')).github(options)
}

export function gitlab(options?: GitlabPluginOptions): VxPlugin | undefined {
  if (process.env['GITLAB_CI'] !== 'true') return undefined
  return (load('./gitlab.js') as typeof import('./gitlab.js')).gitlab(options)
}

export function renderJobSummary(summary: RunSummaryRecord, title?: string): string {
  return (load('./summary.js') as typeof import('./summary.js')).renderJobSummary(summary, title)
}

// The Checks API helpers are the plugin's own; only the transport type
// the options name is public (1.0 freezes what this file exports).
export { type FetchFn } from './checks.js'
