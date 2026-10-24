// `gitlab()`: the run, once on the relay, triggers a pipeline of the
// project's own file per worker with the job's CI_JOB_TOKEN, so no worker
// arrives before it and no token is stored.

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { gitlab } from '../src/index.js'
import type { WorkerSpawn } from '../src/plugin.js'

const saved = { ...process.env }
let server: ReturnType<typeof Bun.serve> | undefined
let calls: { path: string; form: Record<string, string>; headers: string[] }[]
let reply: () => Response
beforeEach(() => {
  calls = []
  reply = () => Response.json({ id: 1 }, { status: 201 })
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const form = await req.formData()
      calls.push({
        path: `${req.method} ${new URL(req.url).pathname}`,
        form: Object.fromEntries(
          [...form].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]),
        ),
        headers: [...req.headers.keys()].filter((h) => /token|authorization/i.test(h)),
      })
      return reply()
    },
  })
  Object.assign(process.env, {
    GITLAB_CI: 'true',
    CI_API_V4_URL: `http://127.0.0.1:${server.port}/api/v4`,
    CI_PROJECT_ID: '7',
    CI_JOB_TOKEN: 'job-token',
    CI_COMMIT_SHA: 'abc123',
    CI_COMMIT_REF_NAME: 'refs/merge-requests/4/head',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'fix-it',
  })
})
afterEach(async () => {
  process.env = { ...saved }
  await server?.stop(true)
})

const worker = {
  id: 'small#2',
  size: 'small',
  env: {
    VX_DTE_RUN: 'r',
    VX_DTE_WORKER: 'small#2',
    VX_DTE_RELAY: 'https://relay',
    VX_DTE_SECRET: 's',
  },
} as unknown as WorkerSpawn

it("triggers the worker's pipeline: its size, the run's commit and the run's env", async () => {
  await gitlab().spawn(worker)
  expect(calls).toEqual([
    {
      path: 'POST /api/v4/projects/7/trigger/pipeline',
      form: {
        token: 'job-token',
        ref: 'fix-it',
        'variables[VX_DTE_RUN]': 'r',
        'variables[VX_DTE_WORKER]': 'small#2',
        'variables[VX_DTE_RELAY]': 'https://relay',
        'variables[VX_DTE_SECRET]': 's',
        'variables[VX_DTE_SIZE]': 'small',
        'variables[VX_DTE_SHA]': 'abc123',
      },
      // The job token goes in the form: no header carries a token.
      headers: [],
    },
  ])
  delete process.env['CI_MERGE_REQUEST_SOURCE_BRANCH_NAME']
  process.env['CI_COMMIT_REF_NAME'] = 'main'
  await gitlab().spawn(worker)
  expect(calls[1]!.form['ref']).toBe('main')
})

it('says a trigger GitLab refused, by status and body', async () => {
  reply = () => new Response('{"message":"403 Forbidden"}', { status: 403 })
  expect(gitlab().spawn(worker)).rejects.toThrow(
    `gitlab(): triggering small#2's pipeline: 403 {"message":"403 Forbidden"}`,
  )
})

it('names a run only in a GitLab job, and starts no worker outside one', async () => {
  expect(gitlab().runId!()).toMatch(/^[0-9a-f-]{36}$/)
  delete process.env['GITLAB_CI']
  expect(gitlab().runId!()).toBeUndefined()
  delete process.env['CI_JOB_TOKEN']
  expect(gitlab().spawn(worker)).rejects.toThrow('gitlab(): not in a GitLab job')
  expect(() => gitlab({ include: 'x' } as never)).toThrow('include')
})
