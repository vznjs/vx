// A PR that changes the relay runs its DTE run on Workers Builds' Preview
// of its commit, and any other PR on the deployed relay (owner,
// 2026-10-25): its client and the deployed relay may speak different
// protocols (Switchboard v1, #4333).
import { describe, expect, it } from 'bun:test'
import {
  githubApi,
  previewUrl,
  workerUrl,
  watched,
  watchOf,
  type PreviewDeps,
} from '../worker-url.ts'

type CheckRun = Awaited<ReturnType<PreviewDeps['checks']>>[number]

// Workers Builds' check on a branch's commit (#4397's, 2026-10-25).
const SUMMARY = [
  'Build ID: [628c134e](https://dash.cloudflare.com/40b1/workers/services/view/vx-dte/production/previews/feat-relay/builds/628c134e)',
  'Script: [vx-dte](https://dash.cloudflare.com/40b1/workers/services/view/vx-dte/production)',
].join('\n')
const DEPLOYED = 'https://vx-dte.exelord.workers.dev'
// private/vx-dte-service/README.md's line.
const WATCH = watchOf(
  '# x\n\n- Watch paths: `packages/vx-dte-server/*`, `private/vx-dte-service/*`, `bun.lock`\n',
)

/** A PR whose head's check runs are `runs`, poll by poll, after `older` commits' (newest first). */
function deps(
  changed: string[],
  runs: (() => Promise<CheckRun[]>)[],
  older: Record<string, { runs: CheckRun[]; since: string[] }> = {},
): PreviewDeps & { slept: number; asked: number } {
  let t = 0
  let i = 0
  const d = {
    slept: 0,
    asked: 0,
    changed: async () => changed,
    commits: async () => {
      d.asked++
      return ['head', ...Object.keys(older)]
    },
    checks: async (sha: string) =>
      sha === 'head' ? runs[Math.min(i++, runs.length - 1)]!() : older[sha]!.runs,
    since: async (sha: string) => older[sha]!.since,
    sleep: async (ms: number) => {
      d.slept++
      t += ms
    },
    now: () => t,
  }
  return d
}

const check =
  (status: string, conclusion: string | null = null, summary = SUMMARY) =>
  async () => [
    { name: 'VX DTE', status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } },
    {
      name: 'Workers Builds: vx-dte',
      status,
      conclusion,
      app: { slug: 'cloudflare-workers-and-pages' },
      output: { summary },
    },
  ]

describe('the relay a PR’s run uses', () => {
  it('is the deployed one when the PR changes no watched path, asked nothing', async () => {
    const d = deps(['packages/vx/src/index.ts'], [() => Promise.reject(new Error('asked'))])
    expect(await workerUrl('vx-dte', WATCH, DEPLOYED, d)).toBeUndefined()
  })

  it('is the Preview of the head commit once its build ends', async () => {
    const d = deps(
      ['packages/vx-dte-server/src/relay.ts'],
      [async () => [], check('in_progress'), check('completed', 'success')],
    )
    expect(await workerUrl('vx-dte', WATCH, DEPLOYED, d)).toBe(
      'https://feat-relay-vx-dte.exelord.workers.dev',
    )
    expect(d.slept).toBe(2)
  })

  it('fails on a failed build, and on none within the wait, naming it', async () => {
    const failed = deps(['bun.lock'], [check('completed', 'failure')])
    await expect(workerUrl('vx-dte', WATCH, DEPLOYED, failed)).rejects.toThrow(
      'Workers Builds: vx-dte ended failure',
    )
    const none = deps(['private/vx-dte-service/wrangler.jsonc'], [async () => []])
    await expect(workerUrl('vx-dte', WATCH, DEPLOYED, none)).rejects.toThrow(
      'Workers Builds: vx-dte: no build of the head after 12 min',
    )
  })

  // With many PRs pushed at once, Workers Builds queues: #4578's build
  // began 8 min after its job asked (2026-10-28), past a 5 min wait.
  it('waits out a busy Workers Builds queue, its build arriving 8 min late', async () => {
    const late = Array.from({ length: 8 * 2 }, () => async () => [] as CheckRun[])
    const d = deps(['bun.lock'], [...late, check('completed', 'success')])
    expect(await workerUrl('vx-dte', WATCH, DEPLOYED, d)).toBe(
      'https://feat-relay-vx-dte.exelord.workers.dev',
    )
    // Every CI job shares the repository's API limit: a PR's commits do
    // not change while it waits, so they are asked once, and the checks
    // every 30 s, not every 5 s (2026-10-28: a dozen jobs at 5 s spent it).
    expect(d.asked).toBe(1)
    expect(d.slept).toBe(16)
    expect(d.now()).toBe(16 * 30_000)
  })

  // Workers Builds skips a push that changes no watch path, so a head
  // with no build may run on an earlier commit's (#4333's 67a4c46 waited 5 min).
  it('is an earlier commit’s Preview when the relay has not changed since', async () => {
    const earlier = SUMMARY.replace('/previews/feat-relay', '/previews/earlier')
    const d = deps(['packages/vx-dte-server/src/relay.ts'], [async () => []], {
      a: { runs: await check('completed', 'success', earlier)(), since: ['packages/vx-dte/a.ts'] },
    })
    expect(await workerUrl('vx-dte', WATCH, DEPLOYED, d)).toBe(
      'https://earlier-vx-dte.exelord.workers.dev',
    )
    expect(d.slept).toBe(0)
  })

  it('waits for the head’s build when an earlier one built other relay code', async () => {
    const earlier = SUMMARY.replace('/previews/feat-relay', '/previews/earlier')
    const d = deps(
      ['packages/vx-dte-server/src/relay.ts'],
      [async () => [], check('completed', 'success')],
      { a: { runs: await check('completed', 'success', earlier)(), since: ['bun.lock'] } },
    )
    expect(await workerUrl('vx-dte', WATCH, DEPLOYED, d)).toBe(
      'https://feat-relay-vx-dte.exelord.workers.dev',
    )
    expect(d.slept).toBe(1)
  })

  // 0dccec2's run dialed the old relay 38 s before its deploy landed.
  it('keeps the deployed relay on main once its deploy of the commit ends', async () => {
    const production = SUMMARY.replace('/previews/feat-relay', '')
    const d = deps(
      ['packages/vx-dte-server/src/relay.ts'],
      [
        async () => [],
        check('in_progress', null, production),
        check('completed', 'success', production),
      ],
    )
    expect(await workerUrl('vx-dte', WATCH, DEPLOYED, d, true)).toBeUndefined()
    expect(d.slept).toBe(2)
    const failed = deps(['bun.lock'], [check('completed', 'failure', production)])
    await expect(workerUrl('vx-dte', WATCH, DEPLOYED, failed, true)).rejects.toThrow(
      'Workers Builds: vx-dte ended failure',
    )
  })

  it('serves the Preview its check names beside the deployed Worker', () => {
    expect(previewUrl(SUMMARY, DEPLOYED)).toBe('https://feat-relay-vx-dte.exelord.workers.dev')
    const production = SUMMARY.replace('/previews/feat-relay', '')
    expect(previewUrl(production, DEPLOYED)).toBeUndefined()
  })

  // Workers Builds builds what its watch paths match, and the run waits for
  // that build: a path one names and the other does not hangs or skips.
  it('watches what a README says Workers Builds watches', () => {
    expect(WATCH).toEqual(['packages/vx-dte-server/', 'private/vx-dte-service/', 'bun.lock'])
    expect(watched(WATCH, ['packages/vx-dte-server-x/a'])).toBe(false)
    expect(() => watchOf('# no line')).toThrow('the README names no `- Watch paths:`')
  })
})

// Every job of the repository shares GITHUB_TOKEN's API limit: with many
// PRs at once it ran out, and the job failed `compare/…: HTTP 403`
// (2026-10-28) where waiting for the reset would have passed.
describe('the GitHub API a job asks', () => {
  const at = (t: number) => {
    let now = t
    const slept: number[] = []
    return {
      slept,
      sleep: async (ms: number) => {
        slept.push(ms)
        now += ms
      },
      now: () => now,
    }
  }
  const limited = (reset: number) =>
    new Response('rate limited', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    })

  it('waits for the limit to reset, then asks again', async () => {
    const clock = at(1_000_000)
    const answers = [limited(1_030), Response.json({ ok: 1 })]
    const api = githubApi('o/r', 't', { fetch: async () => answers.shift()!, ...clock }, 1_100_000)
    expect(await api<{ ok: number }>('commits/x')).toEqual({ ok: 1 })
    expect(clock.slept).toEqual([30_000])
  })

  it('fails on a refusal that is no limit, and on a reset past the wait, naming it', async () => {
    const clock = at(1_000_000)
    const denied = githubApi(
      'o/r',
      't',
      { fetch: async () => new Response('', { status: 403 }), ...clock },
      1_100_000,
    )
    await expect(denied('commits/x')).rejects.toThrow('commits/x: HTTP 403')
    const late = githubApi('o/r', 't', { fetch: async () => limited(2_000), ...clock }, 1_100_000)
    await expect(late('commits/x')).rejects.toThrow(
      'commits/x: HTTP 403, the API limit resets after the wait ends',
    )
    expect(clock.slept).toEqual([])
  })
})
