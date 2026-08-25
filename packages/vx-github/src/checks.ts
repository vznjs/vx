// The Checks API half: one completed `check-run` on the built commit, whose
// output is the same summary markdown the job summary shows. Needs
// `GITHUB_TOKEN` with `checks: write`; the plugin declines the check (not
// the whole sink) without one, so the summary still works token-less.
import type { RunSummaryRecord } from '@vzn/vx'

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface CheckRunEnv {
  token: string
  repository: string
  /** The commit the check attaches to. On `pull_request` events
   *  `GITHUB_SHA` is the MERGE commit; GitHub still renders the check on
   *  the PR, so that is the documented default. */
  sha: string
  apiUrl: string
}

/** Read the Actions environment; `null` when any piece is missing. */
export function resolveCheckRunEnv(env: Record<string, string | undefined>): CheckRunEnv | null {
  const token = env['GITHUB_TOKEN']
  const repository = env['GITHUB_REPOSITORY']
  const sha = env['GITHUB_SHA']
  // All three treated alike: an EMPTY var is as absent as a missing one.
  // Only the token used to be checked for empty, so `GITHUB_REPOSITORY=''`
  // built a POST to `/repos//check-runs` and `GITHUB_SHA=''` sent
  // `head_sha: ''` — a 404 or 422 warning where a clean decline was meant.
  if (
    token === undefined ||
    token === '' ||
    repository === undefined ||
    repository === '' ||
    sha === undefined ||
    sha === ''
  ) {
    return null
  }
  return { token, repository, sha, apiUrl: env['GITHUB_API_URL'] ?? 'https://api.github.com' }
}

/** GitHub caps `output.summary` at 65535 characters; truncate with a tell. */
export function clampSummary(markdown: string): string {
  const MAX = 65_535
  if (markdown.length <= MAX) return markdown
  const suffix = '\n\n…truncated by @vzn/vx-github (65535-char Checks API limit)'
  return markdown.slice(0, MAX - suffix.length) + suffix
}

export function buildCheckRunPayload(args: {
  summary: RunSummaryRecord
  markdown: string
  name: string
  sha: string
}): Record<string, unknown> {
  const ok = args.summary.exitOk
  return {
    name: args.name,
    head_sha: args.sha,
    status: 'completed',
    conclusion: ok ? 'success' : 'failure',
    started_at: new Date(args.summary.startedAt).toISOString(),
    completed_at: new Date(args.summary.endedAt).toISOString(),
    output: {
      title: ok
        ? `${args.summary.taskCount} task${args.summary.taskCount === 1 ? '' : 's'} · ${args.summary.hitCount} cached`
        : `${args.summary.failedCount} failed`,
      summary: clampSummary(args.markdown),
    },
  }
}

/**
 * POST the check run. Failures are REPORTED via `warn`, never thrown —
 * observability must never break a run, and the flush deadline already
 * bounds a slow API.
 */
export async function postCheckRun(args: {
  env: CheckRunEnv
  payload: Record<string, unknown>
  fetchFn: FetchFn
  warn: (m: string) => void
}): Promise<void> {
  const url = `${args.env.apiUrl}/repos/${args.env.repository}/check-runs`
  try {
    const res = await args.fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.env.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'vzn-vx-github',
      },
      body: JSON.stringify(args.payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      args.warn(
        `vx-github: check-run POST failed (${res.status})${res.status === 403 ? ' — does the workflow grant `permissions: checks: write`?' : ''}: ${body.slice(0, 200)}`,
      )
    }
  } catch (err) {
    args.warn(
      `vx-github: check-run POST failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
