// The cloud() backend distribution rung + the §5.3 refusal gates:
//   - no VX_CLOUD_DISTRIBUTE → the rung adds ZERO work (the plain-run pin);
//   - distribute set + no serve configured → hard UserError;
//   - distribute set + unreachable serve → hard UserError from run();
//   - each refusal gate falls back LOUDLY to a normal local run.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserError, parseCachePolicy, type BackendContext, type Logger } from '@vzn/vx'
import { cloud } from '../src/plugin.js'
import { distributedBackend } from '../src/dist/submit.js'

const DIST_ENV_KEYS = [
  'VX_CLOUD_DISTRIBUTE',
  'VX_SERVICE_URL',
  'VX_CLOUD_URL',
  'VX_CLOUD_TOKEN',
  'VX_CLOUD_CONFIG',
  'VX_CLOUD_ENV',
  'VX_CLOUD_AGENT',
]

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

let saved: Record<string, string | undefined>
let scratch: string

beforeEach(async () => {
  saved = {}
  for (const k of DIST_ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  scratch = await mkdtemp(path.join(tmpdir(), 'vx-dist-backend-'))
  // Pin the environments file at an empty temp path so the machine's real
  // config can never leak into these tests.
  process.env['VX_CLOUD_CONFIG'] = path.join(scratch, 'environments.json')
})

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(scratch, { recursive: true, force: true })
})

function ctx(cwd: string): BackendContext {
  return {
    workspaceRoot: cwd,
    cacheDir: path.join(cwd, '.vx', 'cache'),
    warn: () => {},
    request: { tasks: ['build'], cwd },
  }
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-dist-gates-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  const dir = path.join(root, 'packages', 'app')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }))
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default {
       tasks: {
         build: {
           exec: { command: 'echo built > out.txt' },
           cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
         },
       },
     }`,
  )
  const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
  git('init', '-q')
  git('config', 'user.email', 't@vx.local')
  git('config', 'user.name', 'vx test')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return root
}

/** A serve stand-in that answers /health only — enough to pass the probe. */
function healthServe(): { origin: string; stop(): void; submits: () => number } {
  let submits = 0
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url)
      if (url.pathname === '/health') return new Response('ok')
      if (srv.upgrade(req)) return undefined
      return new Response('x', { status: 404 })
    },
    websocket: {
      message() {
        submits++
      },
    },
  })
  return {
    origin: `http://localhost:${server.port}`,
    stop: () => void server.stop(true),
    submits: () => submits,
  }
}

describe('cloud() backend — the distribution rung', () => {
  it('declines with zero work when VX_CLOUD_DISTRIBUTE is unset (the plain-run pin)', async () => {
    const backend = await cloud().backend!(ctx('/nowhere'))
    expect(backend).toBeUndefined()
  })

  it('rejects a malformed VX_CLOUD_DISTRIBUTE loudly', async () => {
    process.env['VX_CLOUD_DISTRIBUTE'] = 'many'
    await expect(cloud().backend!(ctx('/nowhere'))).rejects.toThrow(/invalid VX_CLOUD_DISTRIBUTE/)
  })

  it('hard-errors when distribute is set but no serve is configured', async () => {
    process.env['VX_CLOUD_DISTRIBUTE'] = '2'
    await expect(cloud().backend!(ctx('/nowhere'))).rejects.toThrow(UserError)
    await expect(cloud().backend!(ctx('/nowhere'))).rejects.toThrow(/no vx-cloud serve/)
  })

  it('returns the distributed backend when a serve is configured; an unreachable serve hard-errors at run()', async () => {
    process.env['VX_CLOUD_DISTRIBUTE'] = '2'
    process.env['VX_SERVICE_URL'] = 'http://localhost:1'
    const backend = await cloud().backend!(ctx('/nowhere'))
    expect(backend).toBeDefined()
    await expect(backend!.run({ tasks: ['build'], cwd: '/nowhere' })).rejects.toThrow(/unreachable/)
  })
})

describe('distributedBackend — §5.3 refusal gates fall back loudly to a local run', () => {
  it('forwardArgs: refuses distribution before touching the serve, runs locally', async () => {
    const root = await makeWorkspace()
    const warned: string[] = []
    try {
      const backend = distributedBackend({
        origin: 'http://localhost:1', // unreachable — must never be probed
        expectedAgents: 2,
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({
        tasks: ['build'],
        cwd: root,
        forwardArgs: ['--grep', 'x'],
        outputLogs: 'none',
      })
      expect(result.ok).toBe(true)
      expect(warned.join('\n')).toContain('distribution disabled')
      expect(warned.join('\n')).toContain('forwarded args')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--verify refuses distribution (agents do not run the verify machinery)', async () => {
    const root = await makeWorkspace()
    const warned: string[] = []
    try {
      const backend = distributedBackend({
        origin: 'http://localhost:1', // unreachable — must never be probed
        expectedAgents: 2,
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({
        tasks: ['build'],
        cwd: root,
        verify: { determinism: true, inputs: false, allow: [] },
        outputLogs: 'none',
      })
      expect(result.ok).toBe(true)
      expect(warned.join('\n')).toContain('--verify runs locally')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a cache policy without both remote axes refuses distribution (the cache IS the transport)', async () => {
    const root = await makeWorkspace()
    const warned: string[] = []
    try {
      const backend = distributedBackend({
        origin: 'http://localhost:1',
        expectedAgents: 2,
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({
        tasks: ['build'],
        cwd: root,
        cache: parseCachePolicy('remote:'),
        outputLogs: 'none',
      })
      expect(result.ok).toBe(true)
      expect(warned.join('\n')).toContain('remote layer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a dirty worktree refuses distribution (uncommitted changes cannot exist on agents)', async () => {
    const root = await makeWorkspace()
    const serve = healthServe()
    const warned: string[] = []
    try {
      await writeFile(path.join(root, 'packages', 'app', 'src', 'in.txt'), 'uncommitted-v2')
      const backend = distributedBackend({
        origin: serve.origin,
        expectedAgents: 2,
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({ tasks: ['build'], cwd: root, outputLogs: 'none' })
      expect(result.ok).toBe(true)
      expect(warned.join('\n')).toContain('dirty')
      expect(serve.submits()).toBe(0)
    } finally {
      serve.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a persistent task in the graph refuses distribution', async () => {
    const root = await makeWorkspace()
    const serve = healthServe()
    const warned: string[] = []
    try {
      // A ready-on-echo persistent DEP: the local fallback run spawns it,
      // readiness fires, build runs, and end-of-graph SIGTERMs it — so the
      // fallback completes while the gate still sees a persistent node.
      const dir = path.join(root, 'packages', 'app')
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default {
           tasks: {
             dev: { exec: { command: 'echo ready && sleep 30', persistent: { readyWhen: 'ready' } } },
             build: { exec: { command: 'echo built > out.txt' }, dependsOn: ['dev'] },
           },
         }`,
      )
      const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
      git('add', '-A')
      git('-c', 'user.email=t@vx.local', '-c', 'user.name=vx test', 'commit', '-qm', 'dev task')

      const backend = distributedBackend({
        origin: serve.origin,
        expectedAgents: 2,
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({ tasks: ['build'], cwd: root, outputLogs: 'none' })
      expect(result.ok).toBe(true)
      expect(warned.join('\n')).toContain('persistent')
      expect(serve.submits()).toBe(0)
    } finally {
      serve.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** A serve stand-in answering /health + /v1/agents with the given pool counts. */
function capacityServe(remoteAgents: number): {
  origin: string
  stop(): void
  submits: () => number
} {
  let submits = 0
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url)
      if (url.pathname === '/health') return new Response('ok')
      if (url.pathname === '/v1/agents') {
        return Response.json({
          agents: remoteAgents,
          remoteAgents,
          capacity: remoteAgents,
          remoteCapacity: remoteAgents,
        })
      }
      if (srv.upgrade(req)) return undefined
      return new Response('x', { status: 404 })
    },
    websocket: {
      message() {
        submits++
      },
    },
  })
  return {
    origin: `http://localhost:${server.port}`,
    stop: () => void server.stop(true),
    submits: () => submits,
  }
}

describe('distributedBackend — ambient mode fails SAFE (the local-pool keystone)', () => {
  it('an unreachable pool degrades to a local run (does NOT throw like explicit mode)', async () => {
    const root = await makeWorkspace()
    const warned: string[] = []
    try {
      const backend = distributedBackend({
        origin: 'http://localhost:1', // nothing listening
        expectedAgents: 0,
        mode: 'ambient',
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({ tasks: ['build'], cwd: root, outputLogs: 'none' })
      expect(result.ok).toBe(true)
      expect(warned.join('\n')).toContain('unreachable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a reachable pool with zero remote agents runs locally SILENTLY (fast small case)', async () => {
    const root = await makeWorkspace()
    const serve = capacityServe(0)
    const warned: string[] = []
    try {
      const backend = distributedBackend({
        origin: serve.origin,
        expectedAgents: 0,
        mode: 'ambient',
        sink: silentLogger,
        warn: (l) => warned.push(l),
      })
      const result = await backend.run({ tasks: ['build'], cwd: root, outputLogs: 'none' })
      expect(result.ok).toBe(true)
      // No "distribution disabled" note — a solo run must not be noisy.
      expect(warned.join('\n')).not.toContain('distribution disabled')
      expect(serve.submits()).toBe(0)
    } finally {
      serve.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
