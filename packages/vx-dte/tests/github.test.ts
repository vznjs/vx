// `github()`: the agents one demand starts are one `workflow_dispatch` per
// size, naming the run, the relay, the commit and the agents; a refused
// dispatch says so for each agent.

import { afterEach, expect, it } from 'bun:test'
import type { AgentSpawn } from '../src/index.js'
import { github } from '../src/index.js'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function spawn(id: string, size: string, exited: (why: string) => void = () => {}): AgentSpawn {
  return { id, size, run: 'r1', relay: 'https://relay.test', exited } as AgentSpawn
}

it('dispatches one workflow run per size for the agents one demand starts', async () => {
  const calls: { path: string; auth: string | null; body: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      calls.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get('authorization'),
        body: await req.json(),
      })
      return new Response(null, { status: 204 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
  })
  delete process.env['GITHUB_HEAD_REF']
  try {
    const adapter = github()
    expect(adapter.keyless).toBe(true)
    void adapter.spawn(spawn('small#1', 'small'))
    void adapter.spawn(spawn('small#2', 'small'))
    void adapter.spawn(spawn('big#3', 'big'))
    await Bun.sleep(100)
    const inputs = (size: string, agents: string[]) => ({
      ref: 'main',
      inputs: {
        run: 'r1',
        relay: 'https://relay.test',
        sha: 'abc123',
        size,
        agents: JSON.stringify(agents),
      },
    })
    expect(calls).toEqual([
      {
        path: '/repos/o/r/actions/workflows/vx-agent.yml/dispatches',
        auth: 'Bearer ght',
        body: inputs('small', ['small#1', 'small#2']),
      },
      {
        path: '/repos/o/r/actions/workflows/vx-agent.yml/dispatches',
        auth: 'Bearer ght',
        body: inputs('big', ['big#3']),
      },
    ])
  } finally {
    await server.stop(true)
  }
})

it('says why for each agent of a dispatch GitHub refused', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('nope', { status: 403 }),
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const why: string[] = []
    const adapter = github({ workflow: 'agents.yml' })
    void adapter.spawn(spawn('small#1', 'small', (w) => why.push(`small#1: ${w}`)))
    void adapter.spawn(spawn('small#2', 'small', (w) => why.push(`small#2: ${w}`)))
    await Bun.sleep(100)
    expect(why).toEqual([
      'small#1: github(): dispatching agents.yml: 403 nope',
      'small#2: github(): dispatching agents.yml: 403 nope',
    ])
  } finally {
    await server.stop(true)
  }
})

it('cancels the workflow runs it dispatched when the run closes', async () => {
  const calls: string[] = []
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path} ${req.headers.get('x-github-api-version')}`)
      if (path.endsWith('/dispatches'))
        return Response.json({ workflow_run_id: ++id, run_url: '', html_url: '' })
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small'))
    void adapter.spawn(spawn('mac#2', 'mac'))
    await adapter.close?.()
    expect(calls.toSorted()).toEqual([
      'POST /repos/o/r/actions/runs/1/cancel 2026-03-10',
      'POST /repos/o/r/actions/runs/2/cancel 2026-03-10',
      'POST /repos/o/r/actions/workflows/vx-agent.yml/dispatches 2026-03-10',
      'POST /repos/o/r/actions/workflows/vx-agent.yml/dispatches 2026-03-10',
    ])
  } finally {
    await server.stop(true)
  }
})
