// `gitlab()`: each worker a pipeline of the project's own `.gitlab-ci.yml`
// that the run triggers once it is on the relay (design dte-2026-10.md,
// "Adapters"): a worker never arrives before its run. The trigger takes
// the job's `CI_JOB_TOKEN`, so no token is stored; the worker's pipeline
// runs only the job of its size (`VX_DTE_SIZE`), at the run's commit
// (`VX_DTE_SHA`), and proves itself by the run's secret.

import { refuseUnknownOptions, type PluginOptionKinds } from '@vzn/vx'
import type { DteAdapter } from './plugin.js'

export interface GitlabOptions {
  /** Runner tags by worker size: the runners each size's jobs go to. */
  readonly tags?: Readonly<Record<string, readonly string[]>>
}

const KEYS: PluginOptionKinds<GitlabOptions> = { tags: 'object' }

export function gitlab(options: GitlabOptions = {}): DteAdapter {
  refuseUnknownOptions('gitlab()', options, KEYS)
  return {
    init: async (setup) => (await import('./init.js')).gitlabInit(options, setup),

    async spawn(a) {
      const {
        CI_API_V4_URL: base,
        CI_PROJECT_ID: project,
        CI_JOB_TOKEN: token,
        CI_COMMIT_SHA: sha,
      } = process.env
      if (!base || !project || !token || !sha)
        throw new Error('gitlab(): not in a GitLab job (CI_API_V4_URL, CI_JOB_TOKEN)')
      // A merge request's pipeline is of its source branch; any other, of its ref.
      const ref =
        process.env['CI_MERGE_REQUEST_SOURCE_BRANCH_NAME'] || process.env['CI_COMMIT_REF_NAME']!
      const form = new FormData()
      form.set('token', token)
      form.set('ref', ref)
      const vars = { ...a.env, VX_DTE_SIZE: a.size, VX_DTE_SHA: sha }
      for (const [k, v] of Object.entries(vars)) form.set(`variables[${k}]`, v)
      const res = await fetch(`${base}/projects/${project}/trigger/pipeline`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok)
        throw new Error(
          `gitlab(): triggering ${a.id}'s pipeline: ${res.status} ${(await res.text()).slice(0, 200)}`,
        )
    },

    // Random: a pipeline id is guessable.
    runId() {
      return process.env['GITLAB_CI'] === 'true' && process.env['CI_JOB_TOKEN']
        ? crypto.randomUUID()
        : undefined
    },
  }
}
