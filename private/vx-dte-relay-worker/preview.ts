// The relay a pull request's DTE run uses. Workers Builds makes a Preview
// of this Worker for a branch whose push touches its watch paths
// (README), from that commit's code: such a PR's run must use it, since
// its client and the deployed relay may speak different protocols. Any
// other PR keeps the deployed relay (owner, 2026-10-25: only when the PR
// affects the relay). A push to main that changes the relay waits for its
// deploy. CI runs it before the run; it outputs `url` when the run is to
// use the Preview.

import { appendFile } from 'node:fs/promises'
import path from 'node:path'

/** Workers Builds' watch paths for this Worker, as the dashboard holds them (README). */
export const WATCH = ['packages/vx-dte-relay/', 'private/vx-dte-relay-worker/', 'bun.lock']

/** Whether Workers Builds builds a commit that changes `files`. */
export function watched(files: readonly string[]): boolean {
  return files.some((f) => WATCH.some((w) => (w.endsWith('/') ? f.startsWith(w) : f === w)))
}

/**
 * The Preview's URL, `<preview>-<worker host>`: its check names the
 * Preview only in its dashboard link (`/previews/<name>/builds/`), and
 * the Preview is served beside `deployed`, the Worker's own URL.
 */
export function previewUrl(summary: string, deployed: string): string | undefined {
  const name = /\/previews\/([a-z0-9-]+)\/builds\//.exec(summary)?.[1]
  return name === undefined ? undefined : `https://${name}-${new URL(deployed).host}`
}

interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  app?: { slug?: string }
  output?: { summary?: string | null }
}

export interface PreviewDeps {
  /** The files the PR changes. */
  changed: () => Promise<string[]>
  /** The PR's commits, its head first. */
  commits: () => Promise<string[]>
  /** The check runs on `sha`. */
  checks: (sha: string) => Promise<CheckRun[]>
  /** The files that differ between `sha` and the head commit. */
  since: (sha: string) => Promise<string[]>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const WAIT_MS = 5 * 60_000
const POLL_MS = 5_000

/**
 * The newest check of `name` on the PR's commits whose build is of the
 * head's relay: Workers Builds skips a push that changes no watch path
 * (#4333's 67a4c46), so the head's relay may be an earlier commit's build.
 */
async function build(name: string, deps: PreviewDeps): Promise<CheckRun | undefined> {
  const commits = await deps.commits()
  for (const sha of commits) {
    const run = (await deps.checks(sha)).find(
      (r) => r.app?.slug === 'cloudflare-workers-and-pages' && r.name === name,
    )
    if (run === undefined) continue
    return sha === commits[0] || !watched(await deps.since(sha)) ? run : undefined
  }
  return undefined
}

/**
 * The Preview URL the run is to use, or undefined to keep `deployed`,
 * the Worker's own URL. Waits for the Workers Builds check of `worker`
 * that built the head's relay; a failed or missing build fails, naming why.
 * On `main`, that build deploys the Worker itself: the run waits for it,
 * as one that dialed first met the old relay (0dccec2, 38 s early).
 */
export async function relayFor(
  worker: string,
  deployed: string,
  deps: PreviewDeps,
  main = false,
): Promise<string | undefined> {
  if (!watched(await deps.changed())) return undefined
  const name = `Workers Builds: ${worker}`
  const end = deps.now() + WAIT_MS
  for (;;) {
    const run = await build(name, deps)
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`${name} ended ${run.conclusion}`)
      if (main) return undefined
      const url = previewUrl(run.output?.summary ?? '', deployed)
      if (url === undefined) throw new Error(`${name} names no Preview`)
      return url
    }
    if (deps.now() >= end)
      throw new Error(
        `${name}: ${run === undefined ? 'no build of the head' : run.status} after ${WAIT_MS / 60_000} min`,
      )
    await deps.sleep(POLL_MS)
  }
}

async function git(...args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}`)
  return out
}

if (import.meta.main) {
  const {
    GITHUB_REPOSITORY: repo,
    GITHUB_OUTPUT: out,
    GH_TOKEN: token,
    VX_PR_HEAD: pr,
    GITHUB_SHA: pushed,
    VX_DTE_RELAY: deployed,
  } = process.env
  const head = pr || pushed
  if (!repo || !out || !token || !head || !deployed)
    throw new Error(
      'needs GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN, VX_PR_HEAD or GITHUB_SHA, and VX_DTE_RELAY',
    )
  const wrangler = await Bun.file(path.join(import.meta.dir, 'wrangler.jsonc')).text()
  const worker = /"name":\s*"([^"]+)"/.exec(wrangler)![1]!
  const api = async <T>(route: string): Promise<T> => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`)
    return (await res.json()) as T
  }
  // The checkout is the PR's merge commit, or main's pushed one, one deep:
  // its first parent is the base. One deep, the parent is not here; the
  // commit still names it.
  const base = /^parent ([0-9a-f]+)$/m.exec(await git('cat-file', '-p', 'HEAD'))![1]!
  interface Compare {
    commits: { sha: string }[]
    files?: { filename: string }[]
  }
  const url = await relayFor(
    worker,
    deployed,
    {
      async changed() {
        await git('fetch', '-q', '--depth=1', 'origin', base)
        return (await git('diff', '--name-only', base, 'HEAD')).split('\n').filter((f) => f !== '')
      },
      async commits() {
        if (!pr) return [head]
        const { commits } = await api<Compare>(`compare/${base}...${head}`)
        return commits.map((c) => c.sha).toReversed()
      },
      async checks(sha) {
        return (await api<{ check_runs: CheckRun[] }>(`commits/${sha}/check-runs?per_page=100`))
          .check_runs
      },
      async since(sha) {
        return ((await api<Compare>(`compare/${sha}...${head}`)).files ?? []).map((f) => f.filename)
      },
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
    },
    !pr,
  )
  if (url !== undefined) {
    await appendFile(out, `url=${url}\n`)
    console.log(`relay: ${worker}'s Preview of this commit, ${url}`)
  } else console.log(`relay: the deployed one${pr ? '' : ", with this commit's relay"}`)
}
