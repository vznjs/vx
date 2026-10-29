// `gitlab()`: workers as pipelines of the project's own `.gitlab-ci.yml`
// that the run triggers once it is on the relay (design dte-2026-10.md,
// "Adapters"): a worker never arrives before its run. The trigger takes
// the job's `CI_JOB_TOKEN`, so no token is stored. One pipeline per size
// for each wave the run asks: its `vx-worker <size>` job is a matrix of
// `max` slots (`VX_DTE_SLOT`), of which the rules run those `VX_DTE_PICK`
// names, at the run's commit (`VX_DTE_SHA`). Each proves itself by the
// run's secret.

import { refuseUnknownOptions, type PluginOptionKinds } from '@vzn/vx'
import type { DteAdapter, WorkerSpawn } from './plugin.js'
import { printable } from './printable.js'

export interface GitlabOptions {
  /** Runner tags by worker size: the runners each size's jobs go to. */
  readonly tags?: Readonly<Record<string, readonly string[]>>
}

const KEYS: PluginOptionKinds<GitlabOptions> = { tags: 'object' }

export function gitlab(options: GitlabOptions = {}): DteAdapter {
  refuseUnknownOptions('gitlab()', options, KEYS)
  // The workers asked in one tick, by size: the run asks a wave at once.
  const waves = new Map<string, { workers: WorkerSpawn[]; sent: Promise<void> }>()
  return {
    init: async (setup) => (await import('./init.js')).gitlabInit(options, setup),

    spawn(a) {
      let wave = waves.get(a.size)
      // Two workers in one slot would be one job: the second starts a wave of its own.
      if (wave === undefined || wave.workers.some((w) => slotOf(w) === slotOf(a))) {
        const workers: WorkerSpawn[] = []
        const sent = Promise.resolve().then(() => {
          if (waves.get(a.size) === mine) waves.delete(a.size)
          return trigger(workers)
        })
        const mine = { workers, sent }
        wave = mine
        waves.set(a.size, wave)
      }
      wave.workers.push(a)
      return wave.sent
    },

    workerId() {
      const slot = process.env['VX_DTE_SLOT']
      for (const pair of (process.env['VX_DTE_IDS'] ?? '').split(' ')) {
        const at = pair.indexOf('=')
        if (at > 0 && pair.slice(0, at) === slot) return pair.slice(at + 1)
      }
      return undefined
    },

    // Random: a pipeline id is guessable.
    runId() {
      return process.env['GITLAB_CI'] === 'true' && process.env['CI_JOB_TOKEN']
        ? crypto.randomUUID()
        : undefined
    },
  }
}

/** One pipeline for a wave of one size's workers. */
async function trigger(workers: readonly WorkerSpawn[]): Promise<void> {
  const {
    CI_API_V4_URL: base,
    CI_PROJECT_ID: project,
    CI_JOB_TOKEN: token,
    CI_COMMIT_SHA: sha,
  } = process.env
  if (!base || !project || !token || !sha)
    throw new Error('gitlab(): not in a GitLab job (CI_API_V4_URL, CI_JOB_TOKEN)')
  const first = workers[0]!
  const slots = workers.map((w) => [slotOf(w), w.id] as const)
  // A merge request's pipeline is of its source branch; any other, of its
  // ref. Once a merged request's source branch is deleted mid-run
  // (GitLab's default), GitLab answers 400 "Reference not found": its
  // target's file then, as github() does; the workers check out `sha` either way.
  const refs = [
    process.env['CI_MERGE_REQUEST_SOURCE_BRANCH_NAME'] || process.env['CI_COMMIT_REF_NAME']!,
    process.env['CI_MERGE_REQUEST_TARGET_BRANCH_NAME'],
  ]
  const { VX_DTE_WORKER: _, ...env } = first.env
  const vars: Record<string, string> = {
    ...env,
    VX_DTE_SIZE: first.size,
    VX_DTE_SHA: sha,
    VX_DTE_PICK: `/^(${slots.map(([s]) => s).join('|')})$/`,
    VX_DTE_IDS: slots.map(([s, id]) => `${s}=${id}`).join(' '),
  }
  for (let i = 0; ; i++) {
    const form = new FormData()
    form.set('token', token)
    form.set('ref', refs[i]!)
    for (const [k, v] of Object.entries(vars)) form.set(`variables[${k}]`, v)
    const res = await fetch(`${base}/projects/${project}/trigger/pipeline`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return
    const text = printable((await res.text()).slice(0, 200))
    if (res.status === 400 && text.includes('Reference not found') && refs[i + 1]) continue
    // GitLab.com's new projects let no one set pipeline variables (17.7),
    // and GitLab's words name no setting.
    const fix = text.includes('Insufficient permissions to set pipeline variables')
      ? ": the workers take the run's variables; in the project's Settings > CI/CD > Variables, let the vx job's role use pipeline variables"
      : ''
    throw new Error(
      `gitlab(): triggering ${workers.map((w) => w.id).join(', ')}: ${res.status} ${text}${fix}`,
    )
  }
}

/**
 * A worker's matrix slot: its number within its size, wrapped at `max`.
 * A lost worker's number is never reused, so numbers pass `max`; a wave's
 * are consecutive and at most `max`, so its slots differ.
 */
function slotOf(w: WorkerSpawn): number {
  const n = Number(w.id.slice(w.id.lastIndexOf('#') + 1))
  return ((n - 1) % w.max) + 1
}
