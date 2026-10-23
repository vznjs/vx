// `gitlab()`: workers as jobs of a child pipeline that `vx dte plan` writes
// (design dte-2026-10.md, "Adapters"). The user's own pipeline runs the
// plan job, triggers the child it wrote, and runs the orchestrator, their
// own `vx run`. Every worker the plan wrote starts at once, unless
// `VX_DTE_GITLAB_TOKEN` is set: then only the first does, and the run
// plays the others, manual jobs, as its work needs them.

import { refuseUnknownOptions, UserError, type PluginOptionKinds } from '@vzn/vx'
import type { WorkerSpawn, DteAdapter } from './plugin.js'

export interface GitlabOptions {
  /** The workspace-relative file that holds `.vx-worker`, the job template every worker job extends. */
  readonly include: string
  /** Runner tags by worker size: the runners each size's jobs go to. */
  readonly tags?: Readonly<Record<string, readonly string[]>>
}

const KEYS: PluginOptionKinds<GitlabOptions> = { include: 'string', tags: 'object' }

/** What the child pipeline is written to, workspace-relative. */
const WORKERS_FILE = 'vx-workers.yml'

export function gitlab(options: GitlabOptions): DteAdapter {
  refuseUnknownOptions('gitlab()', options, KEYS)
  if (typeof options.include !== 'string' || options.include === '') {
    throw new UserError(
      "gitlab() needs include: the file holding .vx-worker, such as '.gitlab/vx.yml'",
    )
  }
  const token = (): string | undefined => process.env['VX_DTE_GITLAB_TOKEN'] || undefined
  let jobs: Promise<Map<string, number>> | undefined
  const played = new Set<string>()
  // A played job that fails before its worker joins (checkout, install)
  // tells the run nothing, and a run with no other worker waited for the
  // job's timeout. Each played job is read until it ends; one that ends
  // badly says so.
  const watched = new Map<number, WorkerSpawn>()
  let watch: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const look = (t: string, ms: number): void => {
    watch = setTimeout(() => {
      void Promise.all(
        [...watched].map(async ([id, a]) => {
          const j = (await api(t, 'GET', `jobs/${id}`).catch(() => undefined)) as
            | { status?: string; failure_reason?: string }
            | undefined
          if (j?.status === undefined || !ENDED.has(j.status)) return
          watched.delete(id)
          if (closed) return
          a.exited(`job ${j.status}${j.failure_reason ? ` (${j.failure_reason})` : ''}`)
        }),
      ).then(() => {
        if (!closed && watched.size > 0) look(t, Math.min(2 * ms, WATCH_MAX_MS))
        else watch = undefined
      })
    }, ms)
    watch.unref()
  }
  return {
    live: () => token() !== undefined,

    // A live worker's job, played in the child pipeline; the others the
    // plan started.
    async spawn(a) {
      const t = token()
      if (t === undefined) return
      jobs ??= manualJobs(t).catch((err: unknown) => {
        jobs = undefined
        throw err
      })
      const name = `vx-worker ${a.id}`
      const id = (await jobs).get(name)
      if (id === undefined) throw new Error(`no manual job ${name} in the vx-workers pipeline`)
      played.add(name)
      await api(t, 'POST', `jobs/${id}/play`)
      watched.set(id, a)
      if (watch === undefined && !closed) look(t, WATCH_FIRST_MS)
    },

    // The jobs never played, so the child pipeline ends with the run.
    async close() {
      closed = true
      clearTimeout(watch)
      const t = token()
      if (t === undefined || jobs === undefined) return
      const all = await jobs.catch(() => new Map<string, number>())
      await Promise.all(
        [...all]
          .filter(([name]) => !played.has(name))
          .map(([, id]) => api(t, 'POST', `jobs/${id}/cancel`).catch(() => undefined)),
      )
    },

    render(plan) {
      const lines = [
        `# Written by vx dte plan for run ${plan.run}; do not commit.`,
        'include:',
        `  - local: ${json(options.include)}`,
      ]
      for (const a of plan.workers) {
        const tags = options.tags?.[a.size]
        lines.push(
          '',
          `${json(`vx-worker ${a.id}`)}:`,
          '  extends: .vx-worker',
          '  needs:',
          '    - pipeline: $PARENT_PIPELINE_ID',
          '      job: vx-plan',
          ...(tags === undefined ? [] : ['  tags:', ...tags.map((t) => `    - ${json(t)}`)]),
          ...(a.live ? ['  when: manual'] : []),
          '  variables:',
          `    VX_DTE_RUN: ${json(plan.run)}`,
          `    VX_DTE_WORKER: ${json(a.id)}`,
          `    VX_DTE_RELAY: ${json(plan.relay)}`,
          '  script:',
          `    - ${json('bunx @vzn/vx dte worker')}`,
        )
      }
      return {
        [WORKERS_FILE]: `${lines.join('\n')}\n`,
        // The orchestrator job's run id, as a dotenv report.
        'vx-dte.env': `VX_DTE_RUN=${plan.run}\n`,
      }
    },

    // Random: a pipeline id is guessable. The plan writes it for the others.
    runId() {
      return crypto.randomUUID()
    },
  }
}

const json = (s: string): string => JSON.stringify(s)

/** A played job is first read this soon, then twice as late each time, up to `WATCH_MAX_MS`. */
const WATCH_FIRST_MS = 2_000
const WATCH_MAX_MS = 10_000
/** A job status no job leaves. */
const ENDED = new Set(['success', 'failed', 'canceled', 'skipped'])

/** How long the run waits for the vx-workers child pipeline to exist: 10 s (owner, 2026-10-23). */
const BRIDGE_TRIES = 5
const BRIDGE_WAIT_MS = 2_000

/** A GitLab REST call for this job's project. */
async function api(token: string, method: string, route: string): Promise<unknown> {
  const { CI_API_V4_URL: base, CI_PROJECT_ID: project } = process.env
  if (!base || !project)
    throw new Error('gitlab(): not in a GitLab job (CI_API_V4_URL, CI_PROJECT_ID)')
  const res = await fetch(`${base}/projects/${project}/${route}`, {
    method,
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok)
    throw new Error(
      `gitlab(): ${method} ${route}: ${res.status} ${(await res.text()).slice(0, 200)}`,
    )
  return res.json()
}

/** The manual jobs of the child pipeline this pipeline's `vx-workers` job triggered, by name. */
async function manualJobs(token: string): Promise<Map<string, number>> {
  // The trigger job runs beside this one: its child may not be there yet.
  let child: number | undefined
  for (let i = 0; child === undefined; i++) {
    const bridges = (await api(
      token,
      'GET',
      `pipelines/${process.env['CI_PIPELINE_ID']}/bridges?per_page=100`,
    )) as { name: string; downstream_pipeline: { id: number } | null }[]
    child = bridges.find((b) => b.name === 'vx-workers')?.downstream_pipeline?.id
    if (child !== undefined) break
    if (i >= BRIDGE_TRIES)
      throw new Error('gitlab(): no vx-workers child pipeline in this pipeline')
    await Bun.sleep(BRIDGE_WAIT_MS)
  }
  const out = new Map<string, number>()
  for (let page = 1; ; page++) {
    const jobs = (await api(
      token,
      'GET',
      `pipelines/${child}/jobs?scope[]=manual&per_page=100&page=${page}`,
    )) as {
      id: number
      name: string
    }[]
    for (const j of jobs) out.set(j.name, j.id)
    if (jobs.length < 100) return out
  }
}
