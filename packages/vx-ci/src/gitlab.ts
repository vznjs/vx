// The `gitlab()` plugin (owner, 2026-10-18): on GitLab CI it names the
// run's branch through `setBranch`, as `github()` does on Actions. Off
// GitLab CI (`GITLAB_CI` not 'true') the factory returns undefined, which
// `plugins` skips, so declaring it costs nothing on a laptop.
import {
  type BranchFacts,
  branchCacheScope,
  definePlugin,
  type PluginOptionKinds,
  refuseUnknownOptions,
  type VxPlugin,
} from '@vzn/vx'

export interface GitlabPluginOptions {
  /**
   * Name the run's cache scope and base commit from GitLab's predefined
   * variables: the default branch and a merge train read and write the
   * default keys, any other branch `<project path>:<branch>`, and a merge
   * request is compared with its diff base. `VX_CACHE_SCOPE` beats it.
   * Default: on; `false` opts out.
   */
  cacheScope?: boolean
}

const GITLAB_PLUGIN_KEYS: PluginOptionKinds<GitlabPluginOptions> = {
  cacheScope: 'boolean',
}

export function gitlab(options: GitlabPluginOptions = {}): VxPlugin | undefined {
  if (process.env['GITLAB_CI'] !== 'true') return undefined
  refuseUnknownOptions('gitlab()', options, GITLAB_PLUGIN_KEYS)
  return definePlugin(import.meta, {
    config(_workspace, ctx) {
      if (options.cacheScope === false) return
      ctx.setBranch(gitlabBranch(process.env))
    },
  })
}

/**
 * What a GitLab CI job knows of its branch. A merge request pipeline names
 * its source branch in the project it lives in (a fork's own,
 * `CI_MERGE_REQUEST_SOURCE_PROJECT_PATH`) and its diff base; a merge
 * train's pipeline builds what lands on the target, so it is trusted; a
 * branch or tag pipeline names its ref, none on the default branch.
 */
function gitlabBranch(env: Readonly<Record<string, string | undefined>>): BranchFacts {
  const value = (key: string): string | undefined => env[key] || undefined
  const base = value('CI_MERGE_REQUEST_DIFF_BASE_SHA')
  const withBase = (facts: BranchFacts): BranchFacts =>
    base === undefined ? facts : { ...facts, base }
  if (value('CI_MERGE_REQUEST_EVENT_TYPE') === 'merge_train') return withBase({ trusted: true })
  const project = value('CI_PROJECT_PATH')
  const source = value('CI_MERGE_REQUEST_SOURCE_BRANCH_NAME')
  if (source !== undefined) {
    const from = value('CI_MERGE_REQUEST_SOURCE_PROJECT_PATH') ?? project
    return withBase(from === undefined ? {} : { scope: branchCacheScope(from, source) })
  }
  const ref = value('CI_COMMIT_REF_NAME')
  if (project === undefined || ref === undefined) return {}
  if (value('CI_COMMIT_TAG') === undefined && ref === value('CI_DEFAULT_BRANCH')) return {}
  return { scope: branchCacheScope(project, ref) }
}
