// `github()`: agents as jobs of one workflow the run dispatches per wave
// (design dte-2026-10.md, "Adapters"): `workflow_dispatch` with the run,
// the relay, the commit, a size and the agents of that size, which the
// workflow runs as a matrix on the runners it names for the size. Agents
// prove themselves by their OIDC identity: the run makes no secret.

import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { refuseUnknownOptions, UserError, type PluginOptionKinds } from '@vzn/vx'
import type { AgentSpawn, DteAdapter } from './plugin.js'

export interface GithubOptions {
  /** The agents' workflow file in `.github/workflows` (default `vx-agent.yml`). */
  readonly workflow?: string
}

const KEYS: PluginOptionKinds<GithubOptions> = { workflow: 'string' }

/** In `RUNNER_TEMP`: one dispatched workflow run's API path per line. */
const RUNS_FILE = 'vx-dte-runs'

/** A dispatched run's jobs are first read this soon, then twice as late each time, up to `WATCH_MAX_MS`. */
const WATCH_FIRST_MS = 2_000
const WATCH_MAX_MS = 60_000

export function github(options: GithubOptions = {}): DteAdapter {
  refuseUnknownOptions('github()', options, KEYS)
  const workflow = options.workflow ?? 'vx-agent.yml'
  // The agents one demand starts, by size: one dispatch each.
  const waves = new Map<string, AgentSpawn[]>()
  // The workflow runs dispatched, and the dispatches still in flight: a
  // run that ends first cancels those still queued, or they hold runners
  // (macOS: five a plan) that the next run's agents wait for.
  const runs: string[] = []
  const pending = new Set<Promise<void>>()
  // A job that fails before its agent joins (checkout, install) told the
  // run nothing: its agent stayed `starting`, held its size's `max`, and a
  // run with no other agent waited for the job's timeout (2026-10-22).
  // Each job is named for its agent; one that ends badly says so.
  const watched = new Map<string, Map<string, AgentSpawn>>()
  let watch: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const look = (ms: number): void => {
    watch = setTimeout(() => {
      void Promise.all(
        [...watched].map(async ([run, agents]) => {
          const res = await call(`${run}/jobs?per_page=100`).catch(() => undefined)
          if (res?.ok !== true) return
          const { jobs = [] } = ((await res.json().catch(() => null)) ?? {}) as {
            jobs?: {
              name: string
              status: string
              conclusion: string | null
              steps?: { name: string; conclusion: string | null }[]
            }[]
          }
          for (const j of jobs) {
            const a = agents.get(j.name)
            if (a === undefined || j.status !== 'completed') continue
            agents.delete(j.name)
            if (j.conclusion === 'success' || closed) continue
            const step = j.steps?.find((x) => x.conclusion === 'failure')?.name
            a.exited(`job ${j.conclusion}${step === undefined ? '' : ` at ${step}`}`)
          }
          if (agents.size === 0) watched.delete(run)
        }),
      ).then(() => {
        if (!closed && watched.size > 0) look(Math.min(2 * ms, WATCH_MAX_MS))
        else watch = undefined
      })
    }, ms)
    watch.unref()
  }
  const call = (path: string, init: RequestInit = {}): Promise<Response> => {
    const { GITHUB_API_URL: api, GITHUB_TOKEN: token } = process.env
    return fetch(`${api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        // The version whose dispatch answers with the workflow run's id.
        'x-github-api-version': '2026-03-10',
      },
      signal: AbortSignal.timeout(30_000),
    })
  }
  const dispatch = async (size: string, agents: AgentSpawn[]): Promise<void> => {
    const env = process.env
    const { GITHUB_API_URL: api, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = env
    if (!api || !repo || !token)
      throw new Error(
        'github(): dispatching agents needs GITHUB_TOKEN (actions: write) in a GitHub Actions job',
      )
    const ref = env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME']
    const sha = env['GITHUB_SHA']
    const first = agents[0]!
    const res = await call(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref,
        inputs: {
          run: first.run,
          relay: first.relay,
          sha,
          size,
          agents: JSON.stringify(agents.map((a) => a.id)),
        },
      }),
    })
    if (!res.ok)
      throw new Error(
        `github(): dispatching ${workflow}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      )
    if (res.status === 200) {
      const id = ((await res.json()) as { workflow_run_id?: number }).workflow_run_id
      if (id !== undefined) {
        const run = `/repos/${repo}/actions/runs/${id}`
        runs.push(run)
        watched.set(run, new Map(agents.map((a) => [a.id, a])))
        if (watch === undefined && !closed) look(WATCH_FIRST_MS)
        // For the job's last step, which cancels them when this process
        // dies before close() (a kill, an OOM, the job's timeout).
        if (env['RUNNER_TEMP'])
          await appendFile(path.join(env['RUNNER_TEMP'], RUNS_FILE), `${run}\n`)
      }
    }
  }
  return {
    keyless: true,
    spawn(a) {
      const wave = waves.get(a.size)
      if (wave !== undefined) {
        wave.push(a)
        return
      }
      const agents = [a]
      waves.set(a.size, agents)
      queueMicrotask(() => {
        waves.delete(a.size)
        const p = dispatch(a.size, agents)
          .catch((err: unknown) => {
            const why = err instanceof Error ? err.message : String(err)
            for (const x of agents) x.exited(why)
          })
          .finally(() => pending.delete(p))
        pending.add(p)
      })
    },
    // A finished run answers 409; one still queued or running is the
    // run's no more: its results are in, or the run failed without them.
    async close() {
      closed = true
      clearTimeout(watch)
      await Promise.resolve() // a wave spawned this tick dispatches first
      await Promise.all(pending)
      await Promise.all(
        runs.splice(0).map((run) =>
          // A cancel that fails leaves the run to its timeout, as before.
          call(`${run}/cancel`, { method: 'POST' }).catch(() => {}),
        ),
      )
    },
  }
}

/** The relay token on GitHub Actions: an OIDC token for the relay's URL as audience. */
export async function githubRelayToken(relay: string): Promise<string | undefined> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env
  if (!url || !bearer) return undefined
  const res = await fetch(`${url}&audience=${encodeURIComponent(relay)}`, {
    headers: { authorization: `bearer ${bearer}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new UserError(`dte(): GitHub's OIDC token for the relay: ${res.status}`)
  return ((await res.json()) as { value: string }).value
}
