// The relay a pull request's DTE run uses. Workers Builds makes a Preview
// of this Worker for a branch whose push touches its watch paths
// (README), from that commit's code: such a PR's run must use it, since
// its client and the deployed relay may speak different protocols. Any
// other PR keeps the deployed relay (owner, 2026-10-25: only when the PR
// affects the relay). CI runs it before the run; it outputs `url` when
// the run is to use the Preview.

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
  /** The check runs on the PR's head commit. */
  checks: () => Promise<CheckRun[]>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const WAIT_MS = 5 * 60_000
const POLL_MS = 5_000

/**
 * The Preview URL the run is to use, or undefined to keep `deployed`,
 * the Worker's own URL. Waits for the Workers Builds check of `worker` on the head
 * commit; a failed or missing build fails, naming why.
 */
export async function relayFor(
  worker: string,
  deployed: string,
  deps: PreviewDeps,
): Promise<string | undefined> {
  if (!watched(await deps.changed())) return undefined
  const name = `Workers Builds: ${worker}`
  const end = deps.now() + WAIT_MS
  for (;;) {
    const run = (await deps.checks()).find(
      (r) => r.app?.slug === 'cloudflare-workers-and-pages' && r.name === name,
    )
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`${name} ended ${run.conclusion}`)
      const url = previewUrl(run.output?.summary ?? '', deployed)
      if (url === undefined) throw new Error(`${name} names no Preview`)
      return url
    }
    if (deps.now() >= end)
      throw new Error(
        `${name}: ${run === undefined ? 'no check' : run.status} on the head commit after ${WAIT_MS / 60_000} min`,
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
    VX_PR_HEAD: head,
    VX_DTE_RELAY: deployed,
  } = process.env
  if (!repo || !out || !token || !head || !deployed)
    throw new Error('needs GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN, VX_PR_HEAD and VX_DTE_RELAY')
  const wrangler = await Bun.file(path.join(import.meta.dir, 'wrangler.jsonc')).text()
  const worker = /"name":\s*"([^"]+)"/.exec(wrangler)![1]!
  const url = await relayFor(worker, deployed, {
    // The checkout is the PR's merge commit, one deep: its first parent is the base.
    async changed() {
      const base = (await git('rev-parse', 'HEAD^1')).trim()
      await git('fetch', '-q', '--depth=1', 'origin', base)
      return (await git('diff', '--name-only', base, 'HEAD')).split('\n').filter((f) => f !== '')
    },
    async checks() {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/commits/${head}/check-runs?per_page=100`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
      )
      if (!res.ok) throw new Error(`check runs: HTTP ${res.status}`)
      return ((await res.json()) as { check_runs: CheckRun[] }).check_runs
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
  })
  if (url !== undefined) {
    await appendFile(out, `url=${url}\n`)
    console.log(`relay: ${worker}'s Preview of this commit, ${url}`)
  } else console.log('relay: the deployed one (this PR changes no watched path)')
}
