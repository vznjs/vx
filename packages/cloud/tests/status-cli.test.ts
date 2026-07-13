import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// `vx-cloud status` e2e over the REAL bin (env-cli.test.ts pattern): a stub
// serve emulates the probe surface (/health, /v1/meta, the token-gated
// /v1/runs), VX_CLOUD_CONFIG points at a per-test environments file, and the
// child's cwd selects the workspace context. The doctor's whole job is to
// surface the three silent modes loudly — each has a test.

const BIN = path.join(import.meta.dir, '..', 'src', 'cli', 'bin.ts')

function startStubServe(opts: { auth?: string; token?: string } = {}) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return new Response('ok')
      if (url.pathname === '/v1/meta') {
        return Response.json({ v: 1, name: 'stub', vx: '0.0.0', auth: opts.auth ?? 'open' })
      }
      if (url.pathname === '/v1/runs') {
        if (
          opts.token !== undefined &&
          req.headers.get('authorization') !== `Bearer ${opts.token}`
        ) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        return Response.json({ runs: [] })
      }
      if (url.pathname === '/v1/agents') {
        return Response.json({ agents: 3, remoteAgents: 2, capacity: 8, ready: 0 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    origin: `http://localhost:${server.port}`,
    stop: async () => {
      await server.stop(true)
    },
  }
}

let dir: string
let cfgPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-statuscli-'))
  cfgPath = path.join(dir, 'environments.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function seedEnv(url: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    cfgPath,
    JSON.stringify({ version: 1, active: 't', environments: { t: { url, ...extra } } }),
  )
}

/** A minimal vx workspace (no cloud() declared) for the child's cwd. */
async function makeWorkspace(): Promise<string> {
  const root = path.join(dir, 'ws')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'wsroot' }))
  return root
}

async function status(env: Record<string, string> = {}, cwd?: string) {
  const proc = Bun.spawn(['bun', BIN, 'status'], {
    cwd: cwd ?? dir,
    env: {
      ...process.env,
      VX_CLOUD_CONFIG: cfgPath,
      VX_CLOUD_URL: '',
      VX_CLOUD_TOKEN: '',
      VX_CLOUD_DISTRIBUTE: '',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('vx-cloud status', () => {
  it('reports no connection with the connect hint', async () => {
    const r = await status()
    expect(r.code).toBe(0)
    expect(r.out).toContain('none — connect with')
  })

  it('reports a healthy open connection + identity', async () => {
    const server = startStubServe()
    try {
      await seedEnv(server.origin)
      const r = await status()
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${server.origin}  (active environment)`)
      expect(r.out).toContain('ok (stub · vx 0.0.0 · auth: open)')
    } finally {
      await server.stop()
    }
  })

  it('silent mode 1: names the missing token on an account platform', async () => {
    const server = startStubServe({ auth: 'account' })
    try {
      await seedEnv(server.origin)
      const r = await status()
      expect(r.code).toBe(0)
      expect(r.out).toContain('NO TOKEN on an account platform')
      expect(r.out).toContain('Admin → Tokens')
    } finally {
      await server.stop()
    }
  })

  it('silent mode 3a: a rejected token is named, not swallowed', async () => {
    const server = startStubServe({ auth: 'account', token: 'vxc_good' })
    try {
      await seedEnv(server.origin, { token: 'vxc_stale' })
      const r = await status()
      expect(r.out).toContain('TOKEN REJECTED (401)')
    } finally {
      await server.stop()
    }
  })

  it('silent mode 3b: an unreachable server is named', async () => {
    await seedEnv('http://localhost:1')
    const r = await status()
    expect(r.out).toContain('UNREACHABLE')
  })

  it('silent mode 2: VX_CLOUD_DISTRIBUTE without cloud() is flagged IGNORED', async () => {
    const server = startStubServe()
    try {
      await seedEnv(server.origin)
      const ws = await makeWorkspace()
      const r = await status({ VX_CLOUD_DISTRIBUTE: '4' }, ws)
      expect(r.out).toContain('explicit (VX_CLOUD_DISTRIBUTE=4)')
      expect(r.out).toContain('IGNORED: the workspace never declares cloud()')
      // The pool probe still reports what the serve sees.
      expect(r.out).toContain('2 remote agents')
    } finally {
      await server.stop()
    }
  })

  it('an explicit VX_CLOUD_URL wins over the active environment', async () => {
    const server = startStubServe()
    try {
      await seedEnv('http://localhost:1')
      const r = await status({ VX_CLOUD_URL: server.origin })
      expect(r.out).toContain(`${server.origin}  (env (VX_CLOUD_URL))`)
    } finally {
      await server.stop()
    }
  })
})
