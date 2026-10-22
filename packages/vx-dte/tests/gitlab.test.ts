// `gitlab()` and `vx dte plan`: the plan writes one child-pipeline job per
// agent the run may start, the orchestrator job's run id, and a secret for
// the run, which both sides then read.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { CommandContext } from '@vzn/vx'
import { dte, gitlab } from '../src/index.js'

const DTE = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
const saved = { ...process.env }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-gitlab-'))
  delete process.env['VX_DTE_RUN']
  delete process.env['VX_DTE_SECRET']
  process.env['CI_PIPELINE_ID'] = '900'
})
afterEach(async () => {
  process.env = { ...saved }
  await rm(root, { recursive: true, force: true })
})

function plan(options: Parameters<typeof dte>[0]): Promise<number> {
  const verb = dte(options).commands!['dte']!
  return Promise.resolve(
    verb.run(['plan'], { workspaceRoot: root } as CommandContext),
  ) as Promise<number>
}

it('writes a job per planned agent, the run id and a secret no one else reads', async () => {
  await writeFile(path.join(root, 'pnpm-lock.yaml'), '')
  expect(
    await plan({
      relay: 'https://relay.example.com',
      agents: {
        big: { max: 1, cpu: 16, memory: '64GB' },
        small: { max: 2, cpu: 4, memory: '16GB' },
      },
      adapter: gitlab({ include: '.gitlab/vx.yml', tags: { big: ['saas-linux-xlarge-amd64'] } }),
    }),
  ).toBe(0)
  // A random id, not the pipeline's: that one is guessable.
  const env = await readFile(path.join(root, 'vx-dte.env'), 'utf8')
  const run = /^VX_DTE_RUN=(.+)\n$/.exec(env)![1]!
  expect(run).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(await readFile(path.join(root, 'vx-agents.yml'), 'utf8'))
    .toBe(`# Written by vx dte plan for run ${run}; do not commit.
include:
  - local: ".gitlab/vx.yml"

"vx-agent big#1":
  extends: .vx-agent
  needs:
    - pipeline: $PARENT_PIPELINE_ID
      job: vx-plan
  tags:
    - "saas-linux-xlarge-amd64"
  variables:
    VX_DTE_RUN: "${run}"
    VX_DTE_AGENT: "big#1"
    VX_DTE_RELAY: "https://relay.example.com"
  script:
    - "pnpm exec vx dte agent"

"vx-agent small#2":
  extends: .vx-agent
  needs:
    - pipeline: $PARENT_PIPELINE_ID
      job: vx-plan
  variables:
    VX_DTE_RUN: "${run}"
    VX_DTE_AGENT: "small#2"
    VX_DTE_RELAY: "https://relay.example.com"
  script:
    - "pnpm exec vx dte agent"

"vx-agent small#3":
  extends: .vx-agent
  needs:
    - pipeline: $PARENT_PIPELINE_ID
      job: vx-plan
  variables:
    VX_DTE_RUN: "${run}"
    VX_DTE_AGENT: "small#3"
    VX_DTE_RELAY: "https://relay.example.com"
  script:
    - "pnpm exec vx dte agent"
`)
  const secret = path.join(root, '.vx/dte/secret')
  expect((await readFile(secret, 'utf8')).trim()).toMatch(/^[\w-]{43}$/)
  expect((await stat(secret)).mode & 0o777).toBe(0o600)
})

it('writes no secret when VX_DTE_SECRET is set, and names what a plan needs', async () => {
  process.env['VX_DTE_SECRET'] = 'given'
  const adapter = gitlab({ include: '.gitlab/vx.yml' })
  const agents = { small: { max: 1, cpu: 4, memory: '16GB' } }
  expect(await plan({ relay: 'https://r', agents, adapter })).toBe(0)
  await expect(stat(path.join(root, '.vx/dte/secret'))).rejects.toThrow()
  await expect(
    plan({ relay: 'https://r', agents: { small: { cpu: 4, memory: '16GB' } }, adapter }),
  ).rejects.toThrow('dte(): agents.small needs max: a plan writes that many')
  await expect(plan({ agents, adapter })).rejects.toThrow('vx dte plan needs dte({ relay })')
  process.env['VX_DTE_RUN'] = '900-42'
  await expect(plan({ relay: 'https://r', agents, adapter })).rejects.toThrow(
    'VX_DTE_RUN is a random UUID, such as one `uuidgen` prints, so no one can guess the run: not "900-42"',
  )
  expect(() => gitlab({} as never)).toThrow(
    "gitlab() needs include: the file holding .vx-agent, such as '.gitlab/vx.yml'",
  )
})

it('with VX_DTE_GITLAB_TOKEN, starts what the run keeps busy and plays the others as it asks', async () => {
  // Three independent unmeasured tasks: a core each on 2-core agents, so two of four start.
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws', private: true }),
    '.gitignore': '.vx/cache\nvx-agents.yml\nvx-dte.env\n.vx/dte\n',
    '.vx/workspace.mjs': `import { dte, gitlab } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: 'https://r', agents: { small: { max: 4, cpu: 2, memory: '8GB' } }, adapter: gitlab({ include: '.gitlab/vx.yml' }) })] }
`,
    ...Object.fromEntries(
      ['a', 'b', 'c'].map((p) => [
        `${p}/vx.config.mjs`,
        `export default { name: '${p}', tasks: { t: { exec: { command: 'true' } } } }\n`,
      ]),
    ),
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const vx = (...args: string[]) => {
    const { VX_DTE_RUN: _, ...env } = process.env
    return Bun.spawnSync([process.execPath, CORE_BIN, ...args], {
      cwd: root,
      env: { ...env, VX_DTE_GITLAB_TOKEN: 'glpat-test', VX_DTE_SECRET: 'given', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }
  expect(vx('lock').exitCode).toBe(0)
  const planned = vx('dte', 'plan', 't', '--all')
  expect([planned.exitCode, planned.stderr.toString()]).toEqual([0, ''])
  const yml = await readFile(path.join(root, 'vx-agents.yml'), 'utf8')
  expect(yml.split('\n\n').map((job) => job.includes('when: manual'))).toEqual([
    false,
    false,
    false,
    true,
    true,
  ])
  expect(JSON.parse(await readFile(path.join(root, '.vx/dte/plan.json'), 'utf8'))).toEqual({
    run: expect.stringMatching(/^[0-9a-f-]{36}$/),
    agents: [1, 2, 3, 4].map((i) => ({
      id: `small#${i}`,
      size: 'small',
      cpu: 2,
      memory: 8e9,
      live: i > 2,
    })),
  })
  process.env['VX_DTE_GITLAB_TOKEN'] = 'glpat-test'

  const calls: string[] = []
  let bridgeAsks = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      calls.push(
        `${req.method} ${url.pathname}${req.headers.get('private-token') === 'glpat-test' ? '' : ' (no token)'}`,
      )
      if (url.pathname.endsWith('/pipelines/900/bridges'))
        // The child comes up on the second ask.
        return Response.json([
          { name: 'vx-agents', downstream_pipeline: bridgeAsks++ === 0 ? null : { id: 901 } },
        ])
      if (url.pathname.endsWith('/pipelines/901/jobs'))
        return Response.json([
          { id: 3, name: 'vx-agent small#3' },
          { id: 4, name: 'vx-agent small#4' },
        ])
      return Response.json({})
    },
  })
  process.env['CI_API_V4_URL'] = `http://127.0.0.1:${server.port}/api/v4`
  process.env['CI_PROJECT_ID'] = '7'
  try {
    const adapter = gitlab({ include: '.gitlab/vx.yml' })
    await adapter.spawn({ id: 'small#3' } as Parameters<typeof adapter.spawn>[0])
    await adapter.close!()
    expect(calls).toEqual([
      'GET /api/v4/projects/7/pipelines/900/bridges',
      'GET /api/v4/projects/7/pipelines/900/bridges',
      'GET /api/v4/projects/7/pipelines/901/jobs',
      'POST /api/v4/projects/7/jobs/3/play',
      'POST /api/v4/projects/7/jobs/4/cancel',
    ])
  } finally {
    await server.stop(true)
  }
}, 20_000)

it('says a played agent job that ended before its agent joined, and why', async () => {
  // Before: the job failed in its install, the run heard nothing and
  // waited for the orchestrator job's timeout.
  process.env['VX_DTE_GITLAB_TOKEN'] = 'glpat-test'
  let reads = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/pipelines/900/bridges'))
        return Response.json([{ name: 'vx-agents', downstream_pipeline: { id: 901 } }])
      if (url.pathname.endsWith('/pipelines/901/jobs'))
        return Response.json([{ id: 3, name: 'vx-agent small#3' }])
      if (url.pathname.endsWith('/jobs/3'))
        return Response.json(
          reads++ === 0
            ? { status: 'running' }
            : { status: 'failed', failure_reason: 'script_failure' },
        )
      return Response.json({})
    },
  })
  process.env['CI_API_V4_URL'] = `http://127.0.0.1:${server.port}/api/v4`
  process.env['CI_PROJECT_ID'] = '7'
  try {
    const adapter = gitlab({ include: '.gitlab/vx.yml' })
    const why = Promise.withResolvers<string>()
    await adapter.spawn({ id: 'small#3', exited: why.resolve } as Parameters<
      typeof adapter.spawn
    >[0])
    expect(await why.promise).toBe('job failed (script_failure)')
    expect(reads).toBe(2)
    await adapter.close!()
  } finally {
    await server.stop(true)
  }
}, 20_000)
