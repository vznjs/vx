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
export { github, GithubSummarySink, type GithubPluginOptions } from './plugin.js'
export { renderJobSummary } from './summary.js'
export {
  buildCheckRunPayload,
  clampSummary,
  postCheckRun,
  resolveCheckRunEnv,
  type CheckRunEnv,
  type FetchFn,
} from './checks.js'
