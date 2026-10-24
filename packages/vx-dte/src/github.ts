// `github()`: workers as jobs of one workflow the run dispatches per wave
// (design dte-2026-10.md, "Adapters"): `workflow_dispatch` with the run,
// the relay, the commit, a size and the workers of that size, which the
// workflow runs as a matrix on the runners it names for the size. Workers
// prove themselves by their OIDC identity: the run makes no secret.

import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { refuseUnknownOptions, UserError, type Platform, type PluginOptionKinds } from '@vzn/vx'
import { installLines, vxCommand, type DteInit, type DteSetup } from './init.js'
import type { WorkerSpawn, DteAdapter } from './plugin.js'

export interface GithubOptions {
  /** The workers' workflow file in `.github/workflows` (default `vx-worker.yml`). */
  readonly workflow?: string
  /** The runner label of each size, by size name, which `vx dte init` writes; absent, its platform's GitHub-hosted runner. */
  readonly runsOn?: Readonly<Record<string, string>>
}

const KEYS: PluginOptionKinds<GithubOptions> = { workflow: 'string', runsOn: 'object' }

/** GitHub's hosted runner of each platform; a size naming none runs on Linux x64. */
const RUNNERS: Record<Platform, string> = {
  'linux-x64': 'ubuntu-latest',
  'linux-arm64': 'ubuntu-24.04-arm',
  'darwin-x64': 'macos-15-intel',
  'darwin-arm64': 'macos-latest',
}

/** The workers' workflow: what `dispatch` sends, as `vx dte worker` reads it. */
function workerWorkflow(options: GithubOptions, setup: DteSetup): DteInit {
  const workflow = options.workflow ?? 'vx-worker.yml'
  const runners = Object.fromEntries(
    setup.sizes.map((s) => [
      s.name,
      options.runsOn?.[s.name] ?? RUNNERS[s.platform ?? 'linux-x64'],
    ]),
  )
  const install = [
    ...(setup.manager === 'pnpm'
      ? ['      - uses: pnpm/action-setup@v4']
      : [
          '      # Every project: only pnpm selects by a git diff, as',
          '      # `pnpm install --frozen-lockfile --filter "...[origin/main]"`',
          '      # (fetch origin/main first: the checkout is one commit).',
        ]),
    ...installLines(setup.manager).map((l) => `      - run: ${l}`),
  ]
  const text = `# Written by vx dte init from dte() in .vx/workspace.ts: the workers of a
# distributed run, which github() dispatches once per size. Run vx dte init
# again after changing the sizes.
name: vx-worker

on:
  workflow_dispatch:
    inputs:
      run: { required: true }
      relay: { required: true }
      sha: { required: true }
      size: { required: true }
      workers: { required: true }

permissions:
  contents: read
  id-token: write

jobs:
  worker:
    # The run reads a job that failed before its worker joined by this name.
    name: \${{ matrix.worker }}
    runs-on: \${{ fromJSON('${JSON.stringify(runners)}')[inputs.size] }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        worker: \${{ fromJSON(inputs.workers) }}
    env:
      VX_DTE_RUN: \${{ inputs.run }}
      VX_DTE_RELAY: \${{ inputs.relay }}
      VX_DTE_WORKER: \${{ matrix.worker }}
    steps:
      - uses: actions/checkout@v4
        with: { ref: '\${{ inputs.sha }}' }
      - uses: oven-sh/setup-bun@v2
${install.join('\n')}
      - run: ${vxCommand(setup.manager)} dte worker
`
  const vx = vxCommand(setup.manager)
  const named = setup.tasks.main !== '' && setup.tasks.change !== ''
  const run = `# Written by vx dte init: the run. main runs every task and fills the cache;
# a pull request runs what it changed and its dependents. This job only
# orchestrates: every task runs on a worker (${workflow}).
name: ci

on:
  pull_request:
  push:
    branches: [main]

# A newer push to a pull request cancels its older run, and its workers.
concurrency:
  group: ci-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  vx:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      # The relay and the workers: each side proves itself by its OIDC token.
      id-token: write
      # Dispatching and cancelling the workers.
      actions: write
    env:
      GITHUB_TOKEN: \${{ github.token }}
    steps:
      # One commit: --affected fetches its base itself.
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
${rootInstall(setup.manager).join('\n')}
      - run: ${vx} lock --check
${
  named
    ? ''
    : `      # Name the tasks to run, as '${vx} run build test --affected': with
      # none named, vx fails, listing the workspace's tasks.
`
}      - run: ${vx} run \${{ github.event_name == 'pull_request' && '${both(setup.tasks.change, '--affected')}' || '${both(setup.tasks.main, '--all')}' }}
`
  const repo = setup.repository ?? '<owner>/<repo>'
  return {
    files: { '.github/workflows/ci.yml': run, [`.github/workflows/${workflow}`]: text },
    next: [
      `The relay admits both workflows: ALLOW="${GITHUB_ISSUER}:${repo}:ci.yml ${GITHUB_ISSUER}:${repo}:${workflow}"`,
    ],
  }
}

/** Tasks then a flag, either possibly none. */
export function both(tasks: string, flag: string): string {
  return tasks === '' ? flag : `${tasks} ${flag}`
}

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

/** The run's job needs vx and the plugins only: no task runs there. */
function rootInstall(manager: DteSetup['manager']): string[] {
  if (manager === 'bun') return ["      - run: bun install --frozen-lockfile --filter './'"]
  return [
    ...(manager === 'pnpm' ? ['      - uses: pnpm/action-setup@v4'] : []),
    ...installLines(manager).map((l) => `      - run: ${l}`),
  ]
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
    init: (setup) => workerWorkflow(options, setup),
    keyless: true,
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
        const p = cancelOf(run).finally(() => pending.delete(p))
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
