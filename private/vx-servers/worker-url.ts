// The URL a CI run uses for one of our Workers (the DTE relay, the cache
// server): `worker-url.ts <service dir> <env naming its URL>`. Workers
// Builds makes a Preview of a Worker for a branch whose push touches its
// watch paths (its README), from that commit's code: such a PR's run must
// use it, since its client and the deployed Worker may speak different
// protocols. Any other PR keeps the deployed one (2026-10-25: only
// when the PR affects it). A push to main that changes it waits for its
// deploy; any other push returns at once. CI runs it before the run; it
// outputs `url` when the run is to use the Preview.

import { appendFile } from 'node:fs/promises'
import path from 'node:path'

/** A Worker's watch paths, as the dashboard holds them: its README's `- Watch paths:` line. */
export function watchOf(readme: string): string[] {
  const line = readme.split('\n').find((l) => l.startsWith('- Watch paths:'))
  if (line === undefined) throw new Error('the README names no `- Watch paths:`')
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\*$/, ''))
}

/** Whether Workers Builds builds a commit that changes `files`. */
export function watched(watch: readonly string[], files: readonly string[]): boolean {
  return files.some((f) => watch.some((w) => (w.endsWith('/') ? f.startsWith(w) : f === w)))
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

// Workers Builds queues builds when many PRs push at once: one began
// 8 min after its job asked (2026-10-28). 12 min fits that inside the
// job's 25 min, leaving the run its time.
const WAIT_MS = 12 * 60_000
// Every job of the repository shares GITHUB_TOKEN's API limit, 1000 an
// hour: a dozen jobs asking every 5 s spent it (2026-10-28).
const POLL_MS = 30_000

/**
 * The newest check of `name` on the PR's commits whose build is of the
 * head's Worker: Workers Builds skips a push that changes no watch path
 * (#4333's 67a4c46), so the head's Worker may be an earlier commit's build.
 */
async function build(
  name: string,
  watch: readonly string[],
  deps: PreviewDeps,
): Promise<CheckRun | undefined> {
  const commits = await deps.commits()
  for (const sha of commits) {
    const run = (await deps.checks(sha)).find(
      (r) => r.app?.slug === 'cloudflare-workers-and-pages' && r.name === name,
    )
    if (run === undefined) continue
    return sha === commits[0] || !watched(watch, await deps.since(sha)) ? run : undefined
  }
  return undefined
}

/**
 * The Preview URL the run is to use, or undefined to keep `deployed`,
 * the Worker's own URL. Waits for the Workers Builds check of `worker`
 * that built the head's Worker; a failed or missing build fails, naming why.
 * On `main`, that build deploys the Worker itself: the run waits for it,
 * as one that dialed first met the old relay (0dccec2, 38 s early).
 */
export async function workerUrl(
  worker: string,
  watch: readonly string[],
  deployed: string,
  deps: PreviewDeps,
  main = false,
): Promise<string | undefined> {
  if (!watched(watch, await deps.changed())) return undefined
  // A PR's commits do not change while it waits; every poll asked again,
  // spending the API limit every job of the repository shares.
  // Nor does what changed since an older commit.
  const asked = deps
  const listed = asked.commits()
  const since = new Map<string, Promise<string[]>>()
  deps = {
    ...asked,
    commits: () => listed,
    since: (sha) => since.get(sha) ?? since.set(sha, asked.since(sha)).get(sha)!,
  }
  const name = `Workers Builds: ${worker}`
  const end = deps.now() + WAIT_MS
  for (;;) {
    const run = await build(name, watch, deps)
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

interface ApiDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * GET `route` of `repo`'s GitHub API. Every job of the repository shares
 * GITHUB_TOKEN's limit, which many PRs at once ran out (2026-10-28): a
 * limited answer waits for the reset, if it comes before `end`, and asks
 * again; any other refusal fails, naming the route.
 */
export function githubApi(repo: string, token: string, deps: ApiDeps, end: number) {
  return async function api<T>(route: string): Promise<T> {
    for (;;) {
      const res = await deps.fetch(`https://api.github.com/repos/${repo}/${route}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      })
      if (res.ok) return (await res.json()) as T
      const after = res.headers.get('retry-after')
      const reset = res.headers.get('x-ratelimit-reset')
      const until =
        after !== null
          ? deps.now() + Number(after) * 1000
          : res.headers.get('x-ratelimit-remaining') === '0' && reset !== null
            ? Number(reset) * 1000
            : undefined
      if ((res.status !== 403 && res.status !== 429) || until === undefined || Number.isNaN(until))
        throw new Error(`${route}: HTTP ${res.status}`)
      if (until > end)
        throw new Error(`${route}: HTTP ${res.status}, the API limit resets after the wait ends`)
      await deps.sleep(Math.max(0, until - deps.now()))
    }
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
  } = process.env
  const [, , service, urlEnv] = process.argv
  if (!service || !urlEnv)
    throw new Error('usage: worker-url.ts <service dir> <env naming its URL>')
  const dir = path.resolve(service)
  const deployed = process.env[urlEnv]
  const head = pr || pushed
  if (!repo || !out || !token || !head || !deployed)
    throw new Error(
      `needs GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN, VX_PR_HEAD or GITHUB_SHA, and ${urlEnv}`,
    )
  const wrangler = await Bun.file(path.join(dir, 'wrangler.jsonc')).text()
  const watch = watchOf(await Bun.file(path.join(dir, 'README.md')).text())
  const worker = /"name":\s*"([^"]+)"/.exec(wrangler)![1]!
  const api = githubApi(
    repo,
    token,
    { fetch, sleep: (ms) => Bun.sleep(ms), now: () => Date.now() },
    Date.now() + WAIT_MS,
  )
  // The checkout is the PR's merge commit, or main's pushed one, one deep:
  // its first parent is the base. One deep, the parent is not here; the
  // commit still names it.
  const base = /^parent ([0-9a-f]+)$/m.exec(await git('cat-file', '-p', 'HEAD'))![1]!
  interface Compare {
    commits: { sha: string }[]
    files?: { filename: string }[]
  }
  const url = await workerUrl(
    worker,
    watch,
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
    console.log(`${worker}: its Preview of this commit, ${url}`)
  } else console.log(`${worker}: the deployed one${pr ? '' : ", with this commit's code"}`)
}
