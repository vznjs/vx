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
import {
  type PluginOptionKinds,
  refuseUnknownOptions,
  type RunSummaryRecord,
  UserError,
  type VxPlugin,
} from '@vzn/vx'
import type { GithubPluginOptions } from './plugin.js'
import type { GitlabPluginOptions } from './gitlab.js'

export type { GithubPluginOptions, GitlabPluginOptions }

// Every run evaluates `.vx/workspace.ts`, and off CI both factories
// decline: this file is all a laptop loads (five files were ~1.1 ms of
// every run). Each module loads on its own CI, by `require` as the
// factories are synchronous.
const load = createRequire(import.meta.url)

// Options are checked here, on CI or not: a typo checked only on CI passed
// on a laptop and failed the first CI run (2026-10-28).
const GITHUB_KEYS: PluginOptionKinds<GithubPluginOptions> = {
  summaryFile: 'string',
  title: 'string',
  cacheScope: 'boolean',
}

const GITLAB_KEYS: PluginOptionKinds<GitlabPluginOptions> = {
  cacheScope: 'boolean',
}

export function github(options: GithubPluginOptions = {}): VxPlugin | undefined {
  refuseUnknownOptions('github()', options, GITHUB_KEYS)
  // '' passes the kind check but reads wrong: `??` keeps it, so summaryFile
  // declined instead of using GITHUB_STEP_SUMMARY and title rendered an
  // empty heading.
  for (const key of ['summaryFile', 'title'] as const) {
    if (options[key] === '')
      throw new UserError(`github() option "${key}" must be a non-empty string, got ""`)
  }
  if (process.env['GITHUB_ACTIONS'] !== 'true') return undefined
  return (load('./plugin.js') as typeof import('./plugin.js')).github(options)
}

export function gitlab(options: GitlabPluginOptions = {}): VxPlugin | undefined {
  refuseUnknownOptions('gitlab()', options, GITLAB_KEYS)
  if (process.env['GITLAB_CI'] !== 'true') return undefined
  return (load('./gitlab.js') as typeof import('./gitlab.js')).gitlab(options)
}

export function renderJobSummary(summary: RunSummaryRecord, title?: string): string {
  return (load('./summary.js') as typeof import('./summary.js')).renderJobSummary(summary, title)
}
