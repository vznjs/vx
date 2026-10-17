// The cache scope and base commit a GitHub Actions run names through
// `setBranch`: the default branch writes the default keys, a branch its own
// scope, the one a laptop on that branch reads (owner, 2026-10-17).
import { readFile } from 'node:fs/promises'
import { branchCacheScope } from '@vzn/vx'

/**
 * What an Actions run knows of its branch (owner, 2026-10-17). `scope`:
 * none on a push to the default branch, outside Actions, or when the ref
 * is unknown; else `<owner>/<repo>:<branch>`, the repository and branch a
 * pull request comes from, or the branch or tag pushed. A fork's pull
 * request names the fork, a scope a laptop on the base repository never
 * derives. An event that runs in the default branch's context on a pull
 * request's behalf (`pull_request_target`, `issue_comment` on a PR, a
 * `workflow_run` a PR started) is the PR's, whatever `GITHUB_REF` says: a
 * workflow that checks out the PR's head there would otherwise write the
 * default keys. `issue_comment` names no branch, so it writes `pr-<n>`.
 * `base`: a pull request's base commit (`pull_request.base.sha`), what its
 * merge checkout is compared with, no git call needed.
 */
export async function githubBranch(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ scope?: string; base?: string }> {
  if (env['GITHUB_ACTIONS'] !== 'true') return {}
  const ref = env['GITHUB_REF'] ?? ''
  const event = await eventOf(env['GITHUB_EVENT_PATH'])
  const repo = stringOf(event?.repository?.full_name) ?? env['GITHUB_REPOSITORY']
  const base = stringOf(event?.pull_request?.base?.sha)
  const withBase = (scope: string | undefined): { scope?: string; base?: string } => ({
    ...(scope !== undefined ? { scope } : {}),
    ...(base !== undefined ? { base } : {}),
  })
  if (/^refs\/pull\/\d+\//.test(ref)) {
    const head = event?.pull_request?.head
    const branch = env['GITHUB_HEAD_REF'] || stringOf(head?.ref)
    if (branch !== undefined)
      return withBase(headScope(branch, stringOf(head?.repo?.full_name), repo))
    return withBase('pr-target')
  }
  const onBehalf = prOf(env['GITHUB_EVENT_NAME'], event, repo)
  if (onBehalf !== undefined) return withBase(onBehalf)
  const name = env['GITHUB_REF_NAME']
  if (ref === '' || name === undefined || name === '' || repo === undefined) return {}
  const branch = event?.repository?.default_branch
  if (typeof branch === 'string' && branch !== '' && ref === `refs/heads/${branch}`) return {}
  return { scope: branchCacheScope(repo, name) }
}

interface ActionsEvent {
  repository?: { default_branch?: unknown; full_name?: unknown }
  pull_request?: {
    number?: unknown
    head?: { ref?: unknown; repo?: { full_name?: unknown } }
    base?: { sha?: unknown }
  }
  issue?: { number?: unknown; pull_request?: unknown }
  workflow_run?: {
    event?: unknown
    head_branch?: unknown
    head_repository?: { full_name?: unknown }
    pull_requests?: { number?: unknown }[]
  }
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** A head branch's scope: the repository it lives in (a fork's own), then the branch. */
function headScope(branch: string, headRepo: string | undefined, repo: string | undefined): string {
  return branchCacheScope(headRepo ?? repo ?? 'unknown/unknown', branch)
}

/** The scope of an event that runs in the base branch's context for a PR; `pr-target` when its head is unknown. */
function prOf(
  name: string | undefined,
  event: ActionsEvent | undefined,
  repo: string | undefined,
): string | undefined {
  if (name === 'pull_request_target') {
    const head = event?.pull_request?.head
    const branch = stringOf(head?.ref)
    return branch === undefined
      ? 'pr-target'
      : headScope(branch, stringOf(head?.repo?.full_name), repo)
  }
  if (name === 'issue_comment' && event?.issue?.pull_request != null) {
    const n = event.issue.number
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? `pr-${n}` : 'pr-target'
  }
  const run = event?.workflow_run
  if (
    name === 'workflow_run' &&
    typeof run?.event === 'string' &&
    run.event.startsWith('pull_request')
  ) {
    const branch = stringOf(run.head_branch)
    return branch === undefined
      ? 'pr-target'
      : headScope(branch, stringOf(run.head_repository?.full_name), repo)
  }
  return undefined
}

/** The event payload the runner writes; undefined when it cannot be read. */
async function eventOf(eventPath: string | undefined): Promise<ActionsEvent | undefined> {
  if (eventPath === undefined || eventPath === '') return undefined
  try {
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as unknown
    return typeof event === 'object' && event !== null ? (event as ActionsEvent) : undefined
  } catch {
    return undefined
  }
}
