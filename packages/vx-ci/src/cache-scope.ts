// The cache scope a GitHub Actions run gets when the workspace names none:
// the default branch is trusted, anything else writes to its own scope.
import { readFile } from 'node:fs/promises'

/**
 * `undefined` (leave the workspace's default, trusted) on a push to the
 * default branch, outside Actions, or when the ref is unknown; else
 * `pr-<n>` for a pull request and `ref-<name>` for any other branch or tag.
 */
export async function githubCacheScope(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  if (env['GITHUB_ACTIONS'] !== 'true') return undefined
  const ref = env['GITHUB_REF'] ?? ''
  const pr = /^refs\/pull\/(\d+)\//.exec(ref)
  if (pr !== null) return `pr-${pr[1]}`
  const name = env['GITHUB_REF_NAME']
  if (ref === '' || name === undefined || name === '') return undefined
  if (ref === `refs/heads/${await defaultBranch(env['GITHUB_EVENT_PATH'])}`) return undefined
  // `cacheScope` takes letters, digits and . _ - / @; a ref may hold more.
  return `ref-${name.replace(/[^\w.@/-]/g, '_').slice(0, 124)}`
}

/** The repository's default branch, from the event payload the runner writes. */
async function defaultBranch(eventPath: string | undefined): Promise<string | undefined> {
  if (eventPath === undefined || eventPath === '') return undefined
  try {
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
      repository?: { default_branch?: unknown }
    }
    const branch = event.repository?.default_branch
    return typeof branch === 'string' && branch !== '' ? branch : undefined
  } catch {
    return undefined
  }
}
