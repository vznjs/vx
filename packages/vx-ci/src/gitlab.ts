// The `gitlab()` plugin: on GitLab CI it names the run's branch through
// `setBranch`, as `github()` does on Actions. Off GitLab CI (`GITLAB_CI` not
// 'true') the factory returns undefined, which `plugins` skips, so declaring it
// costs nothing on a laptop.
import { type BranchFacts, branchCacheScope, definePlugin, type VxPlugin } from '@vzn/vx'
import path from 'node:path'
import { warnMissing } from './cache-scope.js'

export interface GitlabPluginOptions {
  /**
   * Name the run's cache scope and base commit from GitLab's predefined
   * variables: none on the default branch (`baseBranch`, else GitLab's) or a merge train, else
   * `<project path>:<branch>`; a merge request is compared with its diff
   * base, a merged results pipeline with the target head, a train car
   * with the car ahead. The scope keys plugin entries only. `VX_CACHE_SCOPE` beats it.
   * Default: on; `false` opts out.
   */
  cacheScope?: boolean
}

export function gitlab(options: GitlabPluginOptions = {}): VxPlugin | undefined {
  if (process.env['GITLAB_CI'] !== 'true') return undefined
  return definePlugin(import.meta, {
    commands: {
      // In the project: GitLab's `cache: paths` keeps only what is under it.
      setup: {
        description: 'gitlab: install and prove the sandbox runtime on this job',
        run: async (argv) =>
          (await import('./setup.js')).runSetup(
            'gitlab',
            argv,
            path.join(process.env['CI_PROJECT_DIR'] ?? process.cwd(), '.vx-setup-debs'),
          ),
      },
    },
    config(workspace, ctx) {
      if (options.cacheScope === false) return
      // GitLab sets each on every job; one that lacks them lost them.
      warnMissing(process.env, GITLAB_VARS, 'gitlab()', (m) => ctx.warn(m))
      ctx.setBranch(gitlabBranch(process.env, workspace.baseBranch, ctx.workspaceRoot))
    },
  })
}

const GITLAB_VARS = ['CI_PROJECT_PATH', 'CI_COMMIT_REF_NAME', 'CI_DEFAULT_BRANCH']

/**
 * What a GitLab CI job knows of its branch. A merge request pipeline names its
 * source branch in the project it lives in (a fork's own,
 * `CI_MERGE_REQUEST_SOURCE_PROJECT_PATH`) and its base (`baseOf`); a merge
 * train's pipeline builds what lands on the target, so it is trusted; a branch
 * or tag pipeline names its ref, none on the default branch. `refs`, what a
 * remote reads: a merge train's only its target branch; any other its own ref
 * (the tag, else a merge request's source branch, else the branch), then a
 * merge request's or external pull request's target, then the default branch.
 */
function gitlabBranch(
  env: Readonly<Record<string, string | undefined>>,
  baseBranch: string | undefined,
  workspaceRoot: string,
): BranchFacts {
  const value = (key: string): string | undefined => env[key] || undefined
  const head = (b: string | undefined) => (b === undefined ? undefined : `refs/heads/${b}`)
  const tag = value('CI_COMMIT_TAG')
  const target = head(
    value('CI_MERGE_REQUEST_TARGET_BRANCH_NAME') ??
      value('CI_EXTERNAL_PULL_REQUEST_TARGET_BRANCH_NAME'),
  )
  const train = value('CI_MERGE_REQUEST_EVENT_TYPE') === 'merge_train'
  const refs = [
    ...new Set(
      (train
        ? [target]
        : [
            tag !== undefined
              ? `refs/tags/${tag}`
              : head(value('CI_MERGE_REQUEST_SOURCE_BRANCH_NAME') ?? value('CI_COMMIT_REF_NAME')),
            target,
            head(baseBranch ?? value('CI_DEFAULT_BRANCH')),
          ]
      ).filter((r): r is string => r !== undefined),
    ),
  ]
  const facts = scopeOf(value, baseBranch, workspaceRoot)
  return refs.length === 0 ? facts : { ...facts, refs }
}

/**
 * The commit a bare `--affected` compares with. A merged results pipeline
 * runs the merge onto the target's head, so it is compared with that head:
 * the diff base took in every change the target got since the branch
 * forked. A train's car merged with a merge commit sits on the car ahead
 * (its first parent, GitLab's `first_parent_ref`), whose pipeline runs that
 * car's changes. Under fast-forward the car is the request's commits
 * rebased onto the car ahead, so `HEAD^1` held only its last commit's
 * changes: it is compared with the target head instead. Any other merge
 * request pipeline runs its source branch: the diff base.
 */
function baseOf(
  value: (key: string) => string | undefined,
  workspaceRoot: string,
): string | undefined {
  const event = value('CI_MERGE_REQUEST_EVENT_TYPE')
  if (event === 'merge_train' && isMerge(workspaceRoot)) return 'HEAD^1'
  const diffBase = value('CI_MERGE_REQUEST_DIFF_BASE_SHA')
  if (event === 'merged_result' || event === 'merge_train')
    return value('CI_MERGE_REQUEST_TARGET_BRANCH_SHA') ?? diffBase
  return diffBase
}

/** Whether HEAD is a merge commit: its own parent lines, which a shallow clone keeps. */
function isMerge(workspaceRoot: string): boolean {
  let proc
  try {
    proc = Bun.spawnSync(['git', 'cat-file', 'commit', 'HEAD'], {
      cwd: workspaceRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch {
    // quiet: a local git, no remote: no git reads as no merge
    return false
  }
  if (proc.exitCode !== 0) return false
  const header = proc.stdout.toString().split('\n\n', 1)[0]!
  return header.split('\n').filter((l) => l.startsWith('parent ')).length > 1
}

function scopeOf(
  value: (key: string) => string | undefined,
  baseBranch: string | undefined,
  workspaceRoot: string,
): BranchFacts {
  const base = baseOf(value, workspaceRoot)
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
  // The workspace's `baseBranch` first, as the refs read it and github() does.
  if (value('CI_COMMIT_TAG') === undefined && ref === (baseBranch ?? value('CI_DEFAULT_BRANCH')))
    return {}
  return { scope: branchCacheScope(project, ref) }
}
