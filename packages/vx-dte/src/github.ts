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
  /** The runner label of each size, by size name, which `vx dte init` writes; absent, its platform's GitHub-hosted runner. */
  readonly runsOn?: Readonly<Record<string, string>>
  /**
   * Variables the run hands its workers, as the workflow's `env` input (a
   * JSON object): a value the run's job decides, such as a server's URL
   * for this commit. An undefined one is left out.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const KEYS: PluginOptionKinds<GithubOptions> = {
  workflow: 'string',
  runsOn: 'object',
  env: 'object',
}

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
const WATCH_MAX_MS = 10_000

export function github(options: GithubOptions = {}): DteAdapter {
  refuseUnknownOptions('github()', options, KEYS)
  const workflow = options.workflow ?? 'vx-worker.yml'
  if (workflow === '' || workflow.includes('/'))
    throw new UserError(
      `github() option "workflow" must be a file name in .github/workflows, such as vx-worker.yml, got ${JSON.stringify(workflow)}`,
    )
  const handed = handedEnv(options.env ?? {})
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
  // The workflow runs whose jobs are this run's workers, by id: a run's id
  // is a dispatch input anyone who reads the repository's Actions sees, so
  // a job of any other run is no worker of it. A dispatch that named no
  // run (an API that answers 204) leaves it unbound.
  const workerRuns = new Set<string>()
  let unbound = false
  // Workers the run no longer needs: a run of only these is cancelled.
  const cancelled = new Set<string>()
  // A poll or cancel that failed is said, each cause once (2026-10-23: no
  // fault is silent): a job that ended badly went unseen, a run held runners.
  let warn = (m: string): void => void process.stderr.write(`[vx] ${m}\n`)
  const said = new Set<string>()
  const runOf = (run: string): string => `workflow run ${run.slice(run.lastIndexOf('/') + 1)}`
  const failed = (what: string, why: string): void => {
    const m = `github(): ${what} failed: ${why}`
    if (said.has(m)) return
    said.add(m)
    warn(m)
  }
  /** A cancel's answer: 202, or 409 for a run already finished; anything else is said. */
  const cancelOf = async (run: string): Promise<void> => {
    const res = await call(`${run}/cancel`, { method: 'POST' }).catch((err: unknown) => {
      failed(`cancelling ${runOf(run)}`, err instanceof Error ? err.message : String(err))
      return undefined
    })
    if (res === undefined || res.ok || res.status === 409) return
    failed(
      `cancelling ${runOf(run)}`,
      `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`,
    )
  }
  /** Cancels `run` once none of its workers is still needed. */
  const letGo = (run: string, workers: ReadonlyMap<string, WorkerSpawn>): void => {
    if (![...workers.keys()].every((id) => cancelled.has(id))) return
    watched.delete(run)
    runs.splice(runs.indexOf(run), 1)
    const p = cancelOf(run).finally(() => pending.delete(p))
    pending.add(p)
  }
  const look = (ms: number): void => {
    watch = setTimeout(() => {
      void Promise.all(
        [...watched].map(async ([run, workers]) => {
          const res = await call(`${run}/jobs?per_page=100`).catch((err: unknown) => {
            failed(`reading ${runOf(run)}'s jobs`, err instanceof Error ? err.message : String(err))
            return undefined
          })
          if (res === undefined) return
          if (!res.ok) {
            failed(
              `reading ${runOf(run)}'s jobs`,
              `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`,
            )
            return
          }
          const { jobs = [] } = ((await res.json().catch((err: unknown) => {
            failed(
              `reading ${runOf(run)}'s jobs`,
              `no JSON: ${err instanceof Error ? err.message : String(err)}`,
            )
            return null
          })) ?? {}) as {
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
            // and the run must not wait on it (2026-10-23).
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
      signal: AbortSignal.timeout(10_000),
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
            ...(options.env === undefined ? {} : { env: handed }),
          },
        }),
      })
      if (res.ok) break
      const text = (await res.text()).slice(0, 200)
      if (res.status !== 422 || !text.includes('No ref found') || !refs[i + 1]) {
        // GitHub's own words named no fix for the two a first run meets (2026-10-26).
        const fix =
          res.status === 404
            ? `: .github/workflows/${workflow} is not on ${refs[i]} (vx dte init writes it; commit and push it)`
            : res.status === 403
              ? ': the job needs `permissions: actions: write` to start workers'
              : ''
        throw new Error(`github(): dispatching ${workflow}: ${res.status} ${text}${fix}`)
      }
    }
    const id =
      res.status === 200
        ? ((await res.json()) as { workflow_run_id?: number }).workflow_run_id
        : undefined
    if (id === undefined) {
      unbound = true
      return
    }
    workerRuns.add(String(id))
    const run = `/repos/${repo}/actions/runs/${id}`
    runs.push(run)
    const mine = new Map(workers.map((a) => [a.id, a]))
    watched.set(run, mine)
    if (watch === undefined && !closed) look(WATCH_FIRST_MS)
    // For the job's last step, which cancels them when this process
    // dies before close() (a kill, an OOM, the job's timeout).
    if (env['RUNNER_TEMP']) await appendFile(path.join(env['RUNNER_TEMP'], RUNS_FILE), `${run}\n`)
    // Let go while this dispatch was in flight: cancel() knew no run.
    if (!closed) letGo(run, mine)
  }
  return {
    // Loaded only by `vx dte init`: a run never needs it.
    init: async (setup) => (await import('./init.js')).githubInit(options, setup),
    keyless: true,
    workerRuns: () => (unbound ? undefined : workerRuns),
    report(w) {
      warn = w
    },
    adopt(worker) {
      const temp = process.env['RUNNER_TEMP']
      if (!temp) return
      let text: string
      try {
        text = readFileSync(path.join(temp, STARTED_FILE), 'utf8')
        // quiet: no list: this job started no worker
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
        workerRuns.add(run.slice(run.lastIndexOf('/') + 1))
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
    // free for others (2026-10-23). A run with a worker still needed
    // goes on; that worker's fellows are told to exit when they join.
    cancel(ids) {
      for (const id of ids) cancelled.add(id)
      for (const [run, workers] of watched) letGo(run, workers)
    },
    // A finished run answers 409; one still queued or running is the
    // run's no more: its results are in, or the run failed without them.
    async close() {
      closed = true
      clearTimeout(watch)
      await Promise.resolve() // a wave spawned this tick dispatches first
      await Promise.all(pending)
      // A cancel that fails leaves the run to its timeout, and says so.
      await Promise.all(runs.splice(0).map(cancelOf))
    },
  }
}

/** The relay token on GitHub Actions: an OIDC token for the relay's URL as audience. */
export async function githubRelayToken(relay: string): Promise<string | undefined> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env
  if (!url || !bearer) return undefined
  // Loaded when asked: a run that is not distributed loads none of it.
  const { oidcToken } = await import('./seal.js')
  return oidcToken(url, bearer, relay).catch((err: unknown) => {
    throw new UserError(
      `dte(): ${err instanceof Error ? err.message : String(err)} (for the relay)`,
    )
  })
}

/**
 * `env` as the workflow's input: each name a variable's, each value one
 * line, since the workflow writes each as a line of `GITHUB_ENV`.
 */
function handedEnv(env: Readonly<Record<string, string | undefined>>): string {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value))
      throw new UserError(
        `github(): env ${JSON.stringify(name)}: a variable's name, and a string of one line`,
      )
    out[name] = value
  }
  return JSON.stringify(out)
}
