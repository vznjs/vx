// A PR that changes the relay runs its DTE run on Workers Builds' Preview
// of its commit, and any other PR on the deployed relay (owner,
// 2026-10-25): its client and the deployed relay may speak different
// protocols (Switchboard v1, #4333).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { previewUrl, relayFor, watched, WATCH, type PreviewDeps } from '../preview.ts'

type CheckRun = Awaited<ReturnType<PreviewDeps['checks']>>[number]

const dir = path.resolve(import.meta.dir, '..')

// Workers Builds' check on a branch's commit (#4397's, 2026-10-25).
const SUMMARY = [
  'Build ID: [628c134e](https://dash.cloudflare.com/40b1/workers/services/view/vx-dte-relay/production/previews/feat-relay/builds/628c134e)',
  'Script: [vx-dte-relay](https://dash.cloudflare.com/40b1/workers/services/view/vx-dte-relay/production)',
].join('\n')
const DEPLOYED = 'https://vx-dte-relay.exelord.workers.dev'

/** A PR whose head's check runs are `runs`, poll by poll, after `older` commits' (newest first). */
function deps(
  changed: string[],
  runs: (() => Promise<CheckRun[]>)[],
  older: Record<string, { runs: CheckRun[]; since: string[] }> = {},
): PreviewDeps & { slept: number } {
  let t = 0
  let i = 0
  const d = {
    slept: 0,
    changed: async () => changed,
    commits: async () => ['head', ...Object.keys(older)],
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
      name: 'Workers Builds: vx-dte-relay',
      status,
      conclusion,
      app: { slug: 'cloudflare-workers-and-pages' },
      output: { summary },
    },
  ]

describe('the relay a PR’s run uses', () => {
  it('is the deployed one when the PR changes no watched path, asked nothing', async () => {
    const d = deps(['packages/vx/src/index.ts'], [() => Promise.reject(new Error('asked'))])
    expect(await relayFor('vx-dte-relay', DEPLOYED, d)).toBeUndefined()
  })

  it('is the Preview of the head commit once its build ends', async () => {
    const d = deps(
      ['packages/vx-dte-relay/src/relay.ts'],
      [async () => [], check('in_progress'), check('completed', 'success')],
    )
    expect(await relayFor('vx-dte-relay', DEPLOYED, d)).toBe(
      'https://feat-relay-vx-dte-relay.exelord.workers.dev',
    )
    expect(d.slept).toBe(2)
  })

  it('fails on a failed build, and on none within the wait, naming it', async () => {
    const failed = deps(['bun.lock'], [check('completed', 'failure')])
    await expect(relayFor('vx-dte-relay', DEPLOYED, failed)).rejects.toThrow(
      'Workers Builds: vx-dte-relay ended failure',
    )
    const none = deps(['private/vx-dte-relay-worker/wrangler.jsonc'], [async () => []])
    await expect(relayFor('vx-dte-relay', DEPLOYED, none)).rejects.toThrow(
      'Workers Builds: vx-dte-relay: no build of the head after 5 min',
    )
  })

  // Workers Builds skips a push that changes no watch path, so a head
  // with no build may run on an earlier commit's (#4333's 67a4c46 waited 5 min).
  it('is an earlier commit’s Preview when the relay has not changed since', async () => {
    const earlier = SUMMARY.replace('/previews/feat-relay', '/previews/earlier')
    const d = deps(['packages/vx-dte-relay/src/relay.ts'], [async () => []], {
      a: { runs: await check('completed', 'success', earlier)(), since: ['packages/vx-dte/a.ts'] },
    })
    expect(await relayFor('vx-dte-relay', DEPLOYED, d)).toBe(
      'https://earlier-vx-dte-relay.exelord.workers.dev',
    )
    expect(d.slept).toBe(0)
  })

  it('waits for the head’s build when an earlier one built other relay code', async () => {
    const earlier = SUMMARY.replace('/previews/feat-relay', '/previews/earlier')
    const d = deps(
      ['packages/vx-dte-relay/src/relay.ts'],
      [async () => [], check('completed', 'success')],
      { a: { runs: await check('completed', 'success', earlier)(), since: ['bun.lock'] } },
    )
    expect(await relayFor('vx-dte-relay', DEPLOYED, d)).toBe(
      'https://feat-relay-vx-dte-relay.exelord.workers.dev',
    )
    expect(d.slept).toBe(1)
  })

  it('serves the Preview its check names beside the deployed Worker', () => {
    expect(previewUrl(SUMMARY, DEPLOYED)).toBe(
      'https://feat-relay-vx-dte-relay.exelord.workers.dev',
    )
    const production = SUMMARY.replace('/previews/feat-relay', '')
    expect(previewUrl(production, DEPLOYED)).toBeUndefined()
  })

  // Workers Builds builds what its watch paths match, and the run waits for
  // that build: a path one names and the other does not hangs or skips.
  it('watches what the README says Workers Builds watches', () => {
    const readme = readFileSync(path.join(dir, 'README.md'), 'utf8')
    const line = readme.split('\n').find((l) => l.startsWith('- Watch paths:'))!
    expect([...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\*$/, ''))).toEqual(WATCH)
    expect(watched(['packages/vx-dte-relay-x/a'])).toBe(false)
  })

  // A Preview inherits no production setting.
  it('gives a Preview the production ALLOW and binding', () => {
    const cfg = Bun.JSONC.parse(readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8')) as {
      vars: Record<string, string>
      durable_objects: unknown
      previews: { vars: Record<string, string>; durable_objects: unknown }
    }
    expect(cfg.previews.vars['ALLOW']).toBe(cfg.vars['ALLOW']!)
    expect(cfg.previews.durable_objects).toEqual(cfg.durable_objects)
  })
})
