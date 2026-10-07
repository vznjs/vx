// The Checks API half: one completed `check-run` on the built commit, whose
// output is the same summary markdown the job summary shows. Needs
// `GITHUB_TOKEN` with `checks: write`; the plugin declines the check (not
// the whole sink) without one, so the summary still works token-less.
import type { RunSummaryRecord } from '@vzn/vx'

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
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
  // The same for the API URL: `??` kept an empty one, and the POST went to a
  // relative URL fetch refuses (item 924).
  const apiUrl = env['GITHUB_API_URL']
  return {
    token,
    repository,
    sha,
    apiUrl: apiUrl === undefined || apiUrl === '' ? 'https://api.github.com' : apiUrl,
  }
}

/** fetch refused the server's certificate (untrusted, expired, wrong name). */
function isCertificateRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return (
    typeof code === 'string' &&
    (code.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  )
}

/**
 * GitHub caps `output.summary` at 65535 characters; truncate with a tell.
 * Counted in UTF-8 bytes, which is never fewer than the characters, so
 * the page fits whichever unit GitHub counts. The cut was in UTF-16 units
 * and split an emoji (the aborted label 🛑) into a lone surrogate the JSON
 * body carried (item 924); it now backs off a continuation byte, as the job
 * summary's does.
 */
export function clampSummary(markdown: string): string {
  const MAX = 65_535
  if (markdown.length * 3 <= MAX) return markdown
  const bytes = new TextEncoder().encode(markdown)
  if (bytes.byteLength <= MAX) return markdown
  const suffix = '\n\n…truncated by @vzn/vx-ci (65535-char Checks API limit)'
  let end = MAX - new TextEncoder().encode(suffix).byteLength
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end)) + suffix
}

export function buildCheckRunPayload(args: {
  summary: RunSummaryRecord
  markdown: string
  name: string
  sha: string
}): Record<string, unknown> {
  const ok = args.summary.exitOk
  // Stopped, not broken: a cancelled CI job's run has aborted tasks and
  // nothing failed, and GitHub has a conclusion for exactly that.
  const cancelled = !ok && args.summary.failedCount === 0 && args.summary.abortedCount > 0
  return {
    name: args.name,
    head_sha: args.sha,
    status: 'completed',
    conclusion: ok ? 'success' : cancelled ? 'cancelled' : 'failure',
    started_at: new Date(args.summary.startedAt).toISOString(),
    completed_at: new Date(args.summary.endedAt).toISOString(),
    output: {
      title: ok
        ? `${args.summary.taskCount} task${args.summary.taskCount === 1 ? '' : 's'} · ${args.summary.hitCount} cached` +
          (args.summary.hitCount > 0
            ? ` (${args.summary.upToDateCount} up-to-date, ${args.summary.restoredLocalCount + args.summary.restoredRemoteCount} restored)`
            : '')
        : cancelled
          ? `cancelled · ${args.summary.abortedCount} aborted`
          : `${args.summary.failedCount} failed`,
      summary: clampSummary(args.markdown),
    },
  }
}

/** Resolves true when `signal` ended the wait. */
function sleepUnless(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve(signal?.aborted === true)
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

const CHECK_RETRY_DELAYS_MS = [200, 800] as const
const CHECK_RETRY_STATUS = new Set([502, 503, 504])

/**
 * POST the check run. Failures are REPORTED via `warn`, never thrown —
 * observability must never break a run. `signal` is core's flush deadline:
 * the deadline alone abandoned the request, and a hanging API kept the
 * process alive with no end (item 1055).
 */
export async function postCheckRun(args: {
  env: CheckRunEnv
  payload: Record<string, unknown>
  fetchFn: FetchFn
  warn: (m: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const url = `${args.env.apiUrl}/repos/${args.env.repository}/check-runs`
  const post = () =>
    args.fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.env.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'vzn-vx-ci',
      },
      body: JSON.stringify(args.payload),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    })
  try {
    // GitHub's own blips (502, 503, 504, a dropped connection) are retried
    // twice, 200 then 800 ms apart, inside the flush deadline: one of them
    // cost the run its check (F-29). A retry after a 502 that GitHub did
    // process adds a second run of the same name, which GitHub shows as one.
    let res: Awaited<ReturnType<FetchFn>> | undefined
    for (let attempt = 0; ; attempt++) {
      const delay = CHECK_RETRY_DELAYS_MS[attempt]
      try {
        res = await post()
        if (!CHECK_RETRY_STATUS.has(res.status) || delay === undefined) break
      } catch (err) {
        // A refused certificate (a GHES host behind a private CA) fails the
        // same way every time: not retried (F-40).
        if (delay === undefined || args.signal?.aborted === true || isCertificateRefusal(err)) {
          throw err
        }
      }
      if (args.signal?.aborted === true) break
      // The deadline ended the wait: GitHub's last answer is what to tell,
      // not the AbortError a further POST would throw (F-46).
      if (await sleepUnless(delay, args.signal)) break
    }
    if (res === undefined) throw new Error('the flush deadline passed before it could be retried')
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // GitHub answers a rate limit (primary or secondary) with 403 as often
      // as 429, and the permissions hint sent every such run to its workflow
      // file. Not retried: its retry-after is seconds to minutes, past core's
      // flush deadline (F-13).
      const limited = res.status === 429 || /rate limit/i.test(body)
      const hint = limited
        ? ' — rate-limited by GitHub; this run has no check'
        : res.status === 403
          ? ' — does the workflow grant `permissions: checks: write`?'
          : ''
      args.warn(`vx-ci: check-run POST failed (${res.status})${hint}: ${body.slice(0, 200)}`)
    }
  } catch (err) {
    // A GHES host behind a private CA: Bun's fetch trusts a CA named there.
    const hint = isCertificateRefusal(err)
      ? " — for a host behind a private CA, set NODE_EXTRA_CA_CERTS to its CA's PEM file"
      : ''
    args.warn(
      `vx-ci: check-run POST failed: ${err instanceof Error ? err.message : String(err)}${hint}`,
    )
  }
}
