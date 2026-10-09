// The cache scope a GitHub Actions run gets when the workspace names none:
// the default branch is trusted, anything else writes to its own scope.
import { readFile } from 'node:fs/promises'

/**
 * `undefined` (leave the workspace's default, trusted) on a push to the
 * default branch, outside Actions, or when the ref is unknown; else
 * `pr-<n>` for a pull request and `ref-<name>` for any other branch or tag.
 * An event that runs in the default branch's context on a pull request's
 * behalf (`pull_request_target`, `issue_comment` on a PR, a `workflow_run`
 * a PR started) is the PR's, whatever `GITHUB_REF` says: a workflow that
 * checks out the PR's head there would otherwise write the trusted keys.
 */
export async function githubCacheScope(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  if (env['GITHUB_ACTIONS'] !== 'true') return undefined
  const ref = env['GITHUB_REF'] ?? ''
  const pr = /^refs\/pull\/(\d+)\//.exec(ref)
  if (pr !== null) return `pr-${pr[1]}`
  const event = await eventOf(env['GITHUB_EVENT_PATH'])
  const onBehalf = prOf(env['GITHUB_EVENT_NAME'], event)
  if (onBehalf !== undefined) return onBehalf
  const name = env['GITHUB_REF_NAME']
  if (ref === '' || name === undefined || name === '') return undefined
  const branch = event?.repository?.default_branch
  if (typeof branch === 'string' && branch !== '' && ref === `refs/heads/${branch}`)
    return undefined
  // `cacheScope` takes letters, digits and . _ - / @; a ref may hold more.
  return `ref-${name.replace(/[^\w.@/-]/g, '_').slice(0, 124)}`
}

interface ActionsEvent {
  repository?: { default_branch?: unknown }
  pull_request?: { number?: unknown }
  issue?: { number?: unknown; pull_request?: unknown }
  workflow_run?: { event?: unknown; pull_requests?: { number?: unknown }[] }
}

/** The PR scope of an event that runs in the base branch's context for a PR; `pr-target` when its number is unknown. */
function prOf(name: string | undefined, event: ActionsEvent | undefined): string | undefined {
  const scope = (n: unknown): string =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 ? `pr-${n}` : 'pr-target'
  if (name === 'pull_request_target') return scope(event?.pull_request?.number)
  if (name === 'issue_comment' && event?.issue?.pull_request != null) {
    return scope(event.issue.number)
  }
  const run = event?.workflow_run
  if (
    name === 'workflow_run' &&
    typeof run?.event === 'string' &&
    run.event.startsWith('pull_request')
  ) {
    return scope(run.pull_requests?.[0]?.number)
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
