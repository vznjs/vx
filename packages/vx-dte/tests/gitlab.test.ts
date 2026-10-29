// `gitlab()`: the run, once on the relay, triggers a pipeline of the
// project's own file per wave and size with the job's CI_JOB_TOKEN, so no
// worker arrives before it and no token is stored.

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

const env = { VX_DTE_RUN: 'r', VX_DTE_RELAY: 'https://relay', VX_DTE_SECRET: 's' }
const spawn = (id: string, size = 'small', max = 8): WorkerSpawn =>
  ({ id, size, max, env: { ...env, VX_DTE_WORKER: id } }) as unknown as WorkerSpawn
const worker = spawn('small#2')

it("triggers one pipeline per size for a wave: its slots, the run's commit and env", async () => {
  const adapter = gitlab()
  // Main ran small#1..8, lost two, and asks small#9 and #10 with a mac.
  await Promise.all([
    adapter.spawn(spawn('small#9')),
    adapter.spawn(spawn('mac#1', 'mac', 2)),
    adapter.spawn(spawn('small#10')),
  ])
  expect(calls).toEqual([
    {
      path: 'POST /api/v4/projects/7/trigger/pipeline',
      form: {
        token: 'job-token',
        ref: 'fix-it',
        'variables[VX_DTE_RUN]': 'r',
        'variables[VX_DTE_RELAY]': 'https://relay',
        'variables[VX_DTE_SECRET]': 's',
        'variables[VX_DTE_SIZE]': 'small',
        'variables[VX_DTE_SHA]': 'abc123',
        'variables[VX_DTE_PICK]': '/^(1|2)$/',
        'variables[VX_DTE_IDS]': '1=small#9 2=small#10',
      },
      // The job token goes in the form: no header carries a token.
      headers: [],
    },
    expect.objectContaining({
      form: expect.objectContaining({
        'variables[VX_DTE_SIZE]': 'mac',
        'variables[VX_DTE_PICK]': '/^(1)$/',
        'variables[VX_DTE_IDS]': '1=mac#1',
      }),
    }),
  ])
  // The next wave is its own pipeline.
  delete process.env['CI_MERGE_REQUEST_SOURCE_BRANCH_NAME']
  process.env['CI_COMMIT_REF_NAME'] = 'main'
  await adapter.spawn(spawn('small#11'))
  expect(calls[2]!.form).toMatchObject({ ref: 'main', 'variables[VX_DTE_IDS]': '3=small#11' })
})

it('never puts two workers of a wave in one slot', async () => {
  const adapter = gitlab()
  // small#1 and small#5 share slot 1 of 4: two pipelines, each one job.
  await Promise.all([
    adapter.spawn(spawn('small#1', 'small', 4)),
    adapter.spawn(spawn('small#5', 'small', 4)),
  ])
  expect(calls.map((c) => c.form['variables[VX_DTE_IDS]'])).toEqual(['1=small#1', '1=small#5'])
})

it("names a worker by its matrix slot in the wave's ids", () => {
  Object.assign(process.env, { VX_DTE_SLOT: '2', VX_DTE_IDS: '1=small#9 2=small#10' })
  expect(gitlab().workerId!()).toBe('small#10')
  process.env['VX_DTE_SLOT'] = '3'
  expect(gitlab().workerId!()).toBeUndefined()
})

it('says a trigger GitLab refused, by status and body', async () => {
  reply = () => new Response('{"message":"403 Forbidden"}', { status: 403 })
  expect(gitlab().spawn(worker)).rejects.toThrow(
    `gitlab(): triggering small#2: 403 {"message":"403 Forbidden"}`,
  )
})

it("writes the controls in GitLab's words as escapes", async () => {
  reply = () => new Response('\x1b]0;PWNED\x07', { status: 403 })
  expect(gitlab().spawn(worker)).rejects.toThrow(
    'gitlab(): triggering small#2: 403 \\x1b]0;PWNED\\x07',
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

it('names exactly the job variables it lacks', async () => {
  delete process.env['CI_JOB_TOKEN']
  delete process.env['CI_COMMIT_SHA']
  await expect(gitlab().spawn(worker)).rejects.toThrow(
    /^gitlab\(\): not in a GitLab job \(CI_JOB_TOKEN, CI_COMMIT_SHA\)$/,
  )
})

it("triggers on the target branch once a merged request's source branch is gone", async () => {
  // Before: a merge request merged mid-run with "delete source branch" (GitLab's
  // default), GitLab answered 400 "Reference not found" and every worker of
  // the wave failed; github() falls back to the base branch the same way.
  process.env['CI_MERGE_REQUEST_TARGET_BRANCH_NAME'] = 'main'
  reply = () =>
    calls.at(-1)!.form['ref'] === 'fix-it'
      ? Response.json({ message: { base: ['Reference not found'] } }, { status: 400 })
      : Response.json({ id: 1 }, { status: 201 })
  await gitlab().spawn(worker)
  expect(calls.map((c) => c.form['ref'])).toEqual(['fix-it', 'main'])
})

it('says a missing ref with no target branch to fall back to', async () => {
  reply = () => Response.json({ message: { base: ['Reference not found'] } }, { status: 400 })
  expect(gitlab().spawn(worker)).rejects.toThrow('gitlab(): triggering small#2: 400')
  await Bun.sleep(0)
})
