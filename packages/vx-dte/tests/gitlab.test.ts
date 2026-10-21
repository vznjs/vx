// `gitlab()` and `vx dte plan`: the plan writes one child-pipeline job per
// agent the run may start, the orchestrator job's run id, and a secret for
// the run, which both sides then read.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { CommandContext } from '@vzn/vx'
import { dte, gitlab } from '../src/index.js'

let root: string
const saved = { ...process.env }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-gitlab-'))
  delete process.env['VX_DTE_RUN']
  delete process.env['VX_DTE_SECRET']
  process.env['CI_PIPELINE_ID'] = '900'
  process.env['CI_JOB_ID'] = '42'
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
  expect(await readFile(path.join(root, 'vx-agents.yml'), 'utf8'))
    .toBe(`# Written by vx dte plan for run 900-42; do not commit.
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
    VX_DTE_RUN: "900-42"
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
    VX_DTE_RUN: "900-42"
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
    VX_DTE_RUN: "900-42"
    VX_DTE_AGENT: "small#3"
    VX_DTE_RELAY: "https://relay.example.com"
  script:
    - "pnpm exec vx dte agent"
`)
  expect(await readFile(path.join(root, 'vx-dte.env'), 'utf8')).toBe('VX_DTE_RUN=900-42\n')
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
  delete process.env['CI_JOB_ID']
  await expect(plan({ relay: 'https://r', agents, adapter })).rejects.toThrow(
    'vx dte plan needs VX_DTE_RUN, or an adapter that names the run',
  )
  expect(() => gitlab({} as never)).toThrow(
    "gitlab() needs include: the file holding .vx-agent, such as '.gitlab/vx.yml'",
  )
})
