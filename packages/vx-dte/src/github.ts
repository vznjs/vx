// `github()`: workers as jobs of one workflow the run dispatches per wave
// (design dte-2026-10.md, "Adapters"): `workflow_dispatch` with the run,
// the relay, the commit, a size and the workers of that size, which the
// workflow runs as a matrix on the runners it names for the size. Workers
// prove themselves by their OIDC identity: the run makes no secret.

import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { refuseUnknownOptions, UserError, type PluginOptionKinds } from '@vzn/vx'
import type { WorkerSpawn, DteAdapter } from './plugin.js'

export interface GithubOptions {
  /** The workers' workflow file in `.github/workflows` (default `vx-worker.yml`). */
  readonly workflow?: string
}

const KEYS: PluginOptionKinds<GithubOptions> = { workflow: 'string' }

/** In `RUNNER_TEMP`: one dispatched workflow run's API path per line. */
const RUNS_FILE = 'vx-dte-runs'

/**
 * In `RUNNER_TEMP`: the worker runs a step dispatched before the run began,
 * one per line, `<API path> <worker>,<worker>`: they start while the job
 * checks out and installs (`adopt`).
 */
const STARTED_FILE = 'vx-dte-started'

/** A dispatched run's jobs are first read this soon, then twice as late each time, up to `WATCH_MAX_MS`. */
const WATCH_FIRST_MS = 2_000
const WATCH_MAX_MS = 60_000

export function github(options: GithubOptions = {}): DteAdapter {
  refuseUnknownOptions('github()', options, KEYS)
  const workflow = options.workflow ?? 'vx-worker.yml'
  // The workers one demand starts, by size: one dispatch each.
  const waves = new Map<string, WorkerSpawn[]>()
  // The workflow runs dispatched, and the dispatches still in flight: a
  // run that ends first cancels those still queued, or they hold runners
  // (macOS: five a plan) that the next run's workers wait for.
  const runs: string[] = []
  const pending = new Set<Promise<void>>()
  // A job that fails before its worker joins (checkout, install) told the
  // run nothing: its worker stayed `starting`, held its size's `max`, and a
  // run with no other worker waited for the job's timeout (2026-10-22).
  // Each job is named for its worker; one that ends badly says so.
  const watched = new Map<string, Map<string, WorkerSpawn>>()
  let watch: ReturnType<typeof setTimeout> | undefined
  let closed = false
  // Workers the run no longer needs: a run of only these is cancelled.
  const cancelled = new Set<string>()
  const look = (ms: number): void => {
    watch = setTimeout(() => {
      void Promise.all(
        [...watched].map(async ([run, workers]) => {
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
            const a = workers.get(j.name)
            if (a === undefined || j.status !== 'completed') continue
            workers.delete(j.name)
            if (closed || cancelled.has(j.name)) continue
            // A success too: a worker that found no live run left at once,
            // and the run must not wait on it (owner, 2026-10-23).
            const step = j.steps?.find((x) => x.conclusion === 'failure')?.name
            a.exited(`job ${j.conclusion}${step === undefined ? '' : ` at ${step}`}`)
          }
          if (workers.size === 0) watched.delete(run)
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
  const dispatch = async (size: string, workers: WorkerSpawn[]): Promise<void> => {
    const env = process.env
    const { GITHUB_API_URL: api, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = env
    if (!api || !repo || !token)
      throw new Error(
        'github(): dispatching workers needs GITHUB_TOKEN (actions: write) in a GitHub Actions job',
      )
    const sha = env['GITHUB_SHA']
    const first = workers[0]!
    // The branch's workflow file, or, once a merged PR's branch is deleted
    // mid-run (GitHub answers 422 "No ref found"), its base's: the workers
    // check out `sha` either way.
    const refs = [env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME'], env['GITHUB_BASE_REF']]
    let res: Response
    for (let i = 0; ; i++) {
      res = await call(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({
          ref: refs[i],
          inputs: {
            run: first.run,
            relay: first.relay,
            sha,
            size,
            workers: JSON.stringify(workers.map((a) => a.id)),
          },
        }),
      })
      if (res.ok) break
      const text = (await res.text()).slice(0, 200)
      if (res.status !== 422 || !text.includes('No ref found') || !refs[i + 1])
        throw new Error(`github(): dispatching ${workflow}: ${res.status} ${text}`)
    }
    if (res.status === 200) {
      const id = ((await res.json()) as { workflow_run_id?: number }).workflow_run_id
      if (id !== undefined) {
        const run = `/repos/${repo}/actions/runs/${id}`
        runs.push(run)
        watched.set(run, new Map(workers.map((a) => [a.id, a])))
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
    adopt(worker) {
      const temp = process.env['RUNNER_TEMP']
      if (!temp) return
      let text: string
      try {
        text = readFileSync(path.join(temp, STARTED_FILE), 'utf8')
      } catch {
        return
      }
      for (const line of text.split('\n')) {
        const [run, ids] = line.trim().split(/\s+/)
        if (!run || !ids) continue
        const workers = new Map<string, WorkerSpawn>()
        for (const id of ids.split(','))
          workers.set(id, worker(id, id.slice(0, id.lastIndexOf('#'))))
        runs.push(run)
        watched.set(run, workers)
      }
      if (watched.size > 0 && watch === undefined) look(WATCH_FIRST_MS)
    },
    spawn(a) {
      const wave = waves.get(a.size)
      if (wave !== undefined) {
        wave.push(a)
        return
      }
      const workers = [a]
      waves.set(a.size, workers)
      queueMicrotask(() => {
        waves.delete(a.size)
        const p = dispatch(a.size, workers)
          .catch((err: unknown) => {
            const why = err instanceof Error ? err.message : String(err)
            for (const x of workers) x.exited(why)
          })
          .finally(() => pending.delete(p))
        pending.add(p)
      })
    },
    // Before a worker's setup when its job has yet to run: its runner is
    // free for others (M, 2026-10-23). A run with a worker still needed
    // goes on; that worker's fellows are told to exit when they join.
    cancel(ids) {
      for (const id of ids) cancelled.add(id)
      for (const [run, workers] of watched) {
        if (![...workers.keys()].every((id) => cancelled.has(id))) continue
        watched.delete(run)
        runs.splice(runs.indexOf(run), 1)
        const p = call(`${run}/cancel`, { method: 'POST' })
          .then(() => {})
          .catch(() => {})
          .finally(() => pending.delete(p))
        pending.add(p)
      }
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
