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

function startStubServe(
  opts: { auth?: string; token?: string; runsStatus?: number; poolSession?: string } = {},
) {
  // Records the session the doctor actually ASKED for: the registry keys on it,
  // so probing the wrong one is a wrong answer, not an approximation.
  const seen: { session?: string } = {}
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return new Response('ok')
      if (url.pathname === '/v1/meta') {
        return Response.json({ v: 1, name: 'stub', vx: '0.0.0', auth: opts.auth ?? 'open' })
      }
      if (url.pathname === '/v1/runs') {
        if (opts.runsStatus !== undefined) {
          return Response.json({ error: 'nope' }, { status: opts.runsStatus })
        }
        if (
          opts.token !== undefined &&
          req.headers.get('authorization') !== `Bearer ${opts.token}`
        ) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        return Response.json({ runs: [] })
      }
      if (url.pathname === '/v1/agents') {
        seen.session = url.searchParams.get('session') ?? ''
        // The pool exists under ONE session key; asking a different one finds
        // nothing, exactly as the real registry behaves.
        const n = opts.poolSession === undefined || opts.poolSession === seen.session ? 2 : 0
        return Response.json({ agents: n, remoteAgents: n, capacity: 8, ready: 0 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    origin: `http://localhost:${server.port}`,
    seen,
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

  it('names the env var that actually supplied the URL', async () => {
    // Reporting VX_CLOUD_URL for a URL that came from VX_SERVICE_URL sends the
    // reader to a variable they never set.
    const server = startStubServe()
    try {
      await seedEnv('http://localhost:1')
      const r = await status({ VX_SERVICE_URL: server.origin })
      expect(r.out).toContain(`${server.origin}  (env (VX_SERVICE_URL))`)
    } finally {
      await server.stop()
    }
  })
})

describe('the fork-PR token is a configured token, not a missing one', () => {
  // A fork job holds ONLY VX_CLOUD_PR_TOKEN — repo secrets are not exposed to
  // forks, which is the whole reason it exists. Reading only `token` reported
  // `NONE` for a CORRECT setup and told the user to mint a trusted token they
  // cannot receive: the anti-pattern the trust scopes exist to prevent.
  it('reports a PR-token-only connection as configured, and presents it', async () => {
    // The stub accepts ONLY the PR token, so `ok` proves it was presented.
    const server = startStubServe({ auth: 'account', token: 'vxc_pr' })
    try {
      await seedEnv('http://localhost:1')
      const r = await status({ VX_CLOUD_URL: server.origin, VX_CLOUD_PR_TOKEN: 'vxc_pr' })
      expect(r.out).toContain('PR token — untrusted cache scope')
      expect(r.out).toContain('auth probe    ok')
      expect(r.out).not.toContain('NO TOKEN on an account platform')
    } finally {
      await server.stop()
    }
  })

  it('reads a prToken off the active environment too', async () => {
    const server = startStubServe({ auth: 'account', token: 'vxc_pr' })
    try {
      await seedEnv(server.origin, { prToken: 'vxc_pr' })
      const r = await status()
      expect(r.out).toContain('PR token — untrusted cache scope')
      expect(r.out).toContain('auth probe    ok')
    } finally {
      await server.stop()
    }
  })

  it('still labels a trusted token trusted, and still warns when neither is set', async () => {
    // Controls: the fix must not relabel the ordinary token, nor silence the
    // genuine no-token warning it was introduced to preserve.
    const server = startStubServe({ auth: 'account', token: 'vxc_good' })
    try {
      await seedEnv(server.origin, { token: 'vxc_good' })
      const trusted = await status()
      expect(trusted.out).toContain('present (trusted)')
      expect(trusted.out).not.toContain('PR token')

      await seedEnv(server.origin)
      const none = await status()
      expect(none.out).toContain('token         NONE')
      expect(none.out).toContain('NO TOKEN on an account platform')
    } finally {
      await server.stop()
    }
  })

  it('treats a 403 as a rejection, not as ok', async () => {
    // The bearer authenticated but may not read here — same silent no-op this
    // row exists to surface. Only 401 was named, so a wrong-scope token read ok.
    const server = startStubServe({ auth: 'account', runsStatus: 403 })
    try {
      await seedEnv(server.origin, { token: 'vxc_scoped' })
      const r = await status()
      expect(r.out).toContain('TOKEN REJECTED (403)')
    } finally {
      await server.stop()
    }
  })
})

describe('the agent-pool probe asks for the session the agents registered under', () => {
  it('derives the CI session, not a bare local', async () => {
    // `VX_AGENT_SESSION ?? 'local'` missed the GitHub/GitLab/Buildkite rungs, so
    // in CI — the only place a pool exists — the doctor probed `local` and
    // reported 0 agents for a healthy pool.
    const server = startStubServe({ poolSession: 'gh-12345-2' })
    try {
      await seedEnv(server.origin)
      const ws = await makeWorkspace()
      const r = await status(
        { VX_CLOUD_DISTRIBUTE: '4', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' },
        ws,
      )
      expect(server.seen.session).toBe('gh-12345-2')
      expect(r.out).toContain('2 remote agents (session gh-12345-2)')
    } finally {
      await server.stop()
    }
  })

  it('an explicit VX_AGENT_SESSION still wins over the CI derivation', async () => {
    // Control: the shared ladder's first rung must keep beating the rest.
    const server = startStubServe({ poolSession: 'mine' })
    try {
      await seedEnv(server.origin)
      const ws = await makeWorkspace()
      const r = await status(
        { VX_CLOUD_DISTRIBUTE: '4', GITHUB_RUN_ID: '12345', VX_AGENT_SESSION: 'mine' },
        ws,
      )
      expect(server.seen.session).toBe('mine')
      expect(r.out).toContain('(session mine)')
    } finally {
      await server.stop()
    }
  })
})
