// The cache scope and base commit a GitHub Actions run names through
// `setBranch`: none on the default branch, a branch its own scope, the one a
// laptop on that branch derives.
import { readFile } from 'node:fs/promises'
import { type BranchFacts, branchCacheScope } from '@vzn/vx'

/**
 * What an Actions run knows of its branch. `scope`: none on a push to the
 * default branch, outside Actions, or when the ref is unknown; else
 * `<owner>/<repo>:<branch>`, the repository and branch a pull request comes
 * from, or the branch or tag pushed. A fork's pull request names the fork, a
 * scope a laptop on the base repository never derives; one whose head
 * repository is unknown (a deleted fork) `pr-<n>`. An event that runs in the
 * default branch's context on a pull request's behalf (`pull_request_target`,
 * `issue_comment` on a PR, a `workflow_run` a PR started) is the PR's, whatever
 * `GITHUB_REF` says: a workflow that checks out the PR's head there would
 * otherwise share main's scope. `issue_comment` names no branch, so it writes
 * `pr-<n>`. A merge queue's run (`merge_group`) is trusted: no scope, compared
 * with `merge_group.base_sha`. A push to a branch named like a queue ref is not
 * one: anyone who can push can name one. `base`: a pull request's base commit
 * (`pull_request.base.sha`), what its merge checkout is compared with, no git
 * call needed. `refs`: what a remote reads (`githubRefs`).
 */
export async function githubBranch(
  env: Readonly<Record<string, string | undefined>>,
  baseBranch?: string,
): Promise<BranchFacts> {
  if (env['GITHUB_ACTIONS'] !== 'true') return {}
  const event = await eventOf(env['GITHUB_EVENT_PATH'])
  const refs = githubRefs(env, event, baseBranch)
  const facts = scopeOf(env, event, baseBranch)
  return refs.length === 0 ? facts : { ...facts, refs }
}

/** The queue ref GitHub names a merge queue's run: `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`. */
const QUEUE = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The refs an Actions run reads, in order: a merge queue's run only its base
 * branch, the code it is about to become; any other a pull request's merge ref
 * (`refs/pull/<n>/merge`, the one scope its token writes), then its own branch
 * (a pull request's head, a `workflow_run` a pull request started included,
 * else `GITHUB_REF`), then the branch it merges into, then the default branch
 * (`baseBranch`, else the event's).
 */
function githubRefs(
  env: Readonly<Record<string, string | undefined>>,
  event: ActionsEvent | undefined,
  baseBranch: string | undefined,
): string[] {
  const head = (b: string | undefined) => (b === undefined ? undefined : `refs/heads/${b}`)
  const ref = stringOf(env['GITHUB_REF'])
  if (queued(env)) {
    const base = stringOf(event?.merge_group?.base_ref) ?? head(QUEUE.exec(ref ?? '')?.[1])
    return base === undefined ? [] : [base]
  }
  const merge = /^refs\/pull\/\d+\//.test(ref ?? '') ? ref : undefined
  // A workflow_run a pull request started is the PR's, as its scope is.
  const run = prRun(env['GITHUB_EVENT_NAME'], event)
  const own = head(stringOf(env['GITHUB_HEAD_REF']) ?? stringOf(run?.head_branch)) ?? ref
  const into = head(
    stringOf(env['GITHUB_BASE_REF']) ?? stringOf(run?.pull_requests?.[0]?.base?.ref),
  )
  const trunk = head(baseBranch ?? stringOf(event?.repository?.default_branch))
  return [...new Set([merge, own, into, trunk].filter((r): r is string => r !== undefined))]
}

/**
 * A merge queue's run: a `merge_group` event only. Anyone who can push can
 * name a branch like a queue ref, so the cache server renames only a
 * `merge_group` run's ref to its base, and only it reads just that base.
 */
const queued = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env['GITHUB_EVENT_NAME'] === 'merge_group'

function scopeOf(
  env: Readonly<Record<string, string | undefined>>,
  event: ActionsEvent | undefined,
  baseBranch: string | undefined,
): BranchFacts {
  const ref = env['GITHUB_REF'] ?? ''
  if (queued(env)) {
    const base = stringOf(event?.merge_group?.base_sha)
    return { trusted: true, ...(base !== undefined ? { base } : {}) }
  }
  const repo = stringOf(event?.repository?.full_name) ?? env['GITHUB_REPOSITORY']
  const base = stringOf(event?.pull_request?.base?.sha)
  const withBase = (scope: string | undefined): { scope?: string; base?: string } => ({
    ...(scope !== undefined ? { scope } : {}),
    ...(base !== undefined ? { base } : {}),
  })
  if (/^refs\/pull\/\d+\//.test(ref)) {
    const head = event?.pull_request?.head
    const branch = env['GITHUB_HEAD_REF'] || stringOf(head?.ref)
    // No readable event: the ref still carries the PR's number, so it keeps
    // its own scope rather than sharing `pr-target` with every such PR.
    const number = event?.pull_request?.number ?? Number(/^refs\/pull\/(\d+)\//.exec(ref)![1])
    if (branch !== undefined)
      return withBase(headScope(branch, stringOf(head?.repo?.full_name), number))
    return withBase('pr-target')
  }
  const onBehalf = prOf(env['GITHUB_EVENT_NAME'], event)
  if (onBehalf !== undefined) return withBase(onBehalf)
  const name = env['GITHUB_REF_NAME']
  if (ref === '' || name === undefined || name === '' || repo === undefined) return {}
  // The workspace's `baseBranch` first, as the refs read it: a run on it
  // has no scope even where the event names no default branch.
  const branch = baseBranch ?? stringOf(event?.repository?.default_branch)
  if (branch !== undefined && ref === `refs/heads/${branch}`) return {}
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
  merge_group?: { base_sha?: unknown; base_ref?: unknown }
  workflow_run?: {
    event?: unknown
    head_branch?: unknown
    head_repository?: { full_name?: unknown }
    pull_requests?: { number?: unknown; base?: { ref?: unknown } }[]
  }
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * A head branch's scope: the repository it lives in (a fork's own), then
 * the branch. A head repository unknown (a deleted fork's is `null`) is
 * the PR's own `pr-<n>`, else `pr-target`: the base repository in its
 * place named the base's own branch of that name.
 */
function headScope(branch: string, headRepo: string | undefined, pr: unknown): string {
  if (headRepo !== undefined) return branchCacheScope(headRepo, branch)
  return prScope(pr)
}

const prScope = (n: unknown): string =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 ? `pr-${n}` : 'pr-target'

/** The scope of an event that runs in the base branch's context for a PR; `pr-target` when its head is unknown. */
function prOf(name: string | undefined, event: ActionsEvent | undefined): string | undefined {
  if (name === 'pull_request_target') {
    const head = event?.pull_request?.head
    const branch = stringOf(head?.ref)
    return branch === undefined
      ? 'pr-target'
      : headScope(branch, stringOf(head?.repo?.full_name), event?.pull_request?.number)
  }
  if (name === 'issue_comment' && event?.issue?.pull_request != null) {
    return prScope(event.issue.number)
  }
  const run = prRun(name, event)
  if (run !== undefined) {
    const branch = stringOf(run.head_branch)
    return branch === undefined
      ? 'pr-target'
      : headScope(branch, stringOf(run.head_repository?.full_name), run.pull_requests?.[0]?.number)
  }
  return undefined
}

/** A `workflow_run` run's triggering run, when a pull request started it. */
function prRun(
  name: string | undefined,
  event: ActionsEvent | undefined,
): NonNullable<ActionsEvent['workflow_run']> | undefined {
  const run = event?.workflow_run
  return name === 'workflow_run' &&
    typeof run?.event === 'string' &&
    run.event.startsWith('pull_request')
    ? run
    : undefined
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
