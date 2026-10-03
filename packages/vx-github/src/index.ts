// Public API for @vzn/vx-github — the GitHub Actions integration plugin.
//
// Usage in vx.workspace.ts:
//   import { defineWorkspace } from '@vzn/vx'
//   import { github } from '@vzn/vx-github'
//   export default defineWorkspace({ plugins: [github()] })
//
// On a GitHub Actions runner (GITHUB_STEP_SUMMARY set) every `vx run`
// appends a job summary: verdict, stats, failures, and the per-task table.
// Anywhere else the plugin declines and costs nothing.
export { github, type GithubPluginOptions } from './plugin.js'
export { renderJobSummary } from './summary.js'
// The Checks API helpers are the plugin's own; only the transport type
// the options name is public (1.0 freezes what this file exports).
export { type FetchFn } from './checks.js'
