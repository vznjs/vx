// GitHub Checks API emitter (road-to-best-CI #2, second half). The job-summary
// table (github-summary.ts) renders on the JOB page; this posts the same result
// as a real CHECK RUN on the commit, so it shows in the PR's checks list with a
// pass/fail conclusion and the per-task table as its output — no log spelunking
// from the PR view at all.
//
// Opt-in = credentials: GitHub Actions never exposes the workflow token as an
// env var by itself, so a check is posted only when the user passes
// `GITHUB_TOKEN` to the vx step (and the workflow grants `checks: write`).
// Without it — or outside Actions — this module resolves to nothing and the
// run is byte-unaffected. Never-fail: a bad token / missing permission warns
// and moves on, exactly like the ingest push.

import { readFile } from 'node:fs/promises'
import type { RunSummaryRecord } from '@vzn/vx'
import { formatGithubSummary, type GithubSummaryOptions } from './github-summary.js'

/** GitHub caps a check run's output.summary at 65535 chars; stay clear of it. */
const MAX_OUTPUT_CHARS = 60_000
const MAX_NAME_CHARS = 100

export interface GithubCheckTarget {
  apiUrl: string
  /** `owner/repo` — GITHUB_REPOSITORY verbatim. */
  repo: string
  headSha: string
  token: string
  /** Check-run name shown in the PR checks list. */
  name: string
}

/**
 * Quick synchronous gate for the plugin's telemetry activation: are the
 * ingredients for a check present? (The full target — which also reads the
 * event payload for the PR head SHA — resolves async at flush time.)
 */
export function githubCheckCandidate(env: Record<string, string | undefined>): boolean {
  if (env['VX_GITHUB_CHECK'] === '0' || env['VX_GITHUB_CHECK'] === 'false') return false
  return (
    env['GITHUB_ACTIONS'] === 'true' &&
    (env['GITHUB_TOKEN'] ?? '') !== '' &&
    (env['GITHUB_REPOSITORY'] ?? '') !== '' &&
    (env['GITHUB_SHA'] ?? '') !== ''
  )
}

/**
 * The SHA the check attaches to. For `pull_request` events GITHUB_SHA is the
 * synthetic MERGE commit — a check created there does not surface on the PR —
 * so prefer the head SHA from the event payload (the dorny/test-reporter
 * convention); push events and a malformed/absent payload fall back to
 * GITHUB_SHA.
 */
async function resolveHeadSha(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const eventPath = env['GITHUB_EVENT_PATH']
  if (eventPath !== undefined && eventPath !== '') {
    try {
      const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
        pull_request?: { head?: { sha?: unknown } }
      }
      const sha = event.pull_request?.head?.sha
      if (typeof sha === 'string' && sha !== '') return sha
    } catch {
      // fall through to GITHUB_SHA
    }
  }
  const sha = env['GITHUB_SHA']
  return sha !== undefined && sha !== '' ? sha : undefined
}

/** Resolve the full check target, or undefined when any ingredient is missing. */
export async function resolveGithubCheckTarget(
  env: Record<string, string | undefined>,
  commandName?: string,
): Promise<GithubCheckTarget | undefined> {
  if (!githubCheckCandidate(env)) return undefined
  const headSha = await resolveHeadSha(env)
  if (headSha === undefined) return undefined
  // Empty-string overrides fall through — a nameless check run is a 422.
  const name = env['VX_GITHUB_CHECK_NAME'] || commandName || 'vx run'
  return {
    apiUrl: (env['GITHUB_API_URL'] ?? 'https://api.github.com').replace(/\/+$/, ''),
    repo: env['GITHUB_REPOSITORY']!,
    headSha,
    token: env['GITHUB_TOKEN']!,
    name: name.slice(0, MAX_NAME_CHARS),
  }
}

/**
 * Create a COMPLETED check run for the summary — one POST, conclusion from
 * `exitOk`, the job-summary markdown as the check output. Never throws.
 */
export async function postGithubCheck(
  target: GithubCheckTarget,
  summary: RunSummaryRecord,
  warn: (message: string) => void,
  opts: GithubSummaryOptions = {},
): Promise<void> {
  const markdown = formatGithubSummary(summary, opts)
  const body = JSON.stringify({
    name: target.name,
    head_sha: target.headSha,
    status: 'completed',
    conclusion: summary.exitOk ? 'success' : 'failure',
    completed_at: new Date(summary.endedAt).toISOString(),
    // The PR checks list's "Details" link — straight to the run's dashboard
    // page when a connection resolved (DX-2).
    ...(opts.dashboardUrl !== undefined ? { details_url: opts.dashboardUrl } : {}),
    output: {
      title: summary.exitOk
        ? `passed — ${summary.taskCount} tasks, ${summary.hitCount} cache hits`
        : `failed — ${summary.failedCount} of ${summary.taskCount} tasks`,
      summary:
        markdown.length > MAX_OUTPUT_CHARS
          ? `${markdown.slice(0, MAX_OUTPUT_CHARS)}\n\n_… truncated._`
          : markdown,
    },
  })
  // Clearable timer (NOT AbortSignal.timeout — its internal timer is not
  // unref'd and would keep the CLI alive after the POST resolved).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${target.apiUrl}/repos/${target.repo}/check-runs`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body,
      signal: controller.signal,
    })
    if (!res.ok) {
      // 403 = the workflow didn't grant `checks: write`; name the fix.
      const hint = res.status === 403 ? ' (grant `checks: write` in the workflow permissions)' : ''
      warn(`[vx] github check: HTTP ${res.status}${hint}`)
    }
  } catch (err) {
    warn(`[vx] github check: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}
