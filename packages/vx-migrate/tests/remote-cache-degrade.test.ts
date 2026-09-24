// The remote-caching guide makes one promise to an adopter: "Any failure —
// a 500, a timeout, an auth error, a corrupt artifact — degrades to a local
// cache miss and the run continues." Core's LayeredCache suite proves that
// at the SEAM, with stub layers. This file proves it through the two
// plugins that ship, on a real `vx run`, against a server that is hostile
// in each of those four ways — which is where an adopter meets it.
//
// A hostile server, not a stub layer: the plugin's own request, status and
// body handling sits between the seam and the wire, and it is what a 500 or
// a truncated body reaches first.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const TOKEN = 'tok'
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

type Mode = 'ok' | 'error' | 'hang' | 'corrupt' | 'unauthorized' | 'put413' | 'puthang'

/** One server for both wires; `mode` is what the next request meets. */
function hostileServer() {
  const store = new Map<string, Uint8Array>()
  const state: { mode: Mode } = { mode: 'ok' }
  const hashOf = (pathname: string): string | undefined =>
    /^\/(?:v8\/artifacts|v1\/cache)\/([0-9a-z]+)$/.exec(pathname)?.[1]
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (state.mode === 'unauthorized') return new Response('nope', { status: 401 })
      if (state.mode === 'error') return new Response('boom', { status: 500 })
      if (state.mode === 'hang') {
        // Long enough that the client's 700 ms deadline always wins, short
        // enough that a straggler cannot outlive the suite — and it lets go
        // the moment the client aborts, so `stop()` has nothing to wait for
        // (awaiting a stop with a 60 s sleep still pending timed the hook
        // out at 5 s, 2026-09-20).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000)
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        return new Response('late', { status: 200 })
      }
      const hash = hashOf(url.pathname)
      if (hash === undefined) {
        // Turbo's batch query, the only POST either wire makes.
        if (req.method === 'POST' && url.pathname === '/v8/artifacts') {
          const { hashes } = (await req.json()) as { hashes: string[] }
          return Response.json(Object.fromEntries(hashes.map((h) => [h, store.get(h) ? {} : null])))
        }
        return new Response('not found', { status: 404 })
      }
      if (req.method === 'PUT' && state.mode === 'put413') {
        return new Response('too large', { status: 413 })
      }
      if (req.method === 'PUT' && state.mode === 'puthang') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000)
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        return new Response(null, { status: 202 })
      }
      if (req.method === 'PUT') {
        store.set(hash, new Uint8Array(await req.arrayBuffer()))
        return new Response(null, { status: 202 })
      }
      const held = store.get(hash)
      if (held === undefined) return new Response('not found', { status: 404 })
      if (req.method === 'HEAD') return new Response(null, { status: 200 })
      if (state.mode === 'corrupt') {
        // A body that is not a vx artifact at all: the restore has to fail
        // INSIDE the cache and come back a miss, not tear down the task.
        return new Response(new TextEncoder().encode('not-an-artifact'), { status: 200 })
      }
      return new Response(held, { status: 200 })
    },
  })
  return {
    store,
    state,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

/** A workspace whose one task writes a file, with `plugin` above the local cache. */
async function fixture(plugin: string, importName: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-degrade-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n")
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
  await writeFile(path.join(root, 'pkg', 'src', 'app.js'), 'console.log("app")\n')
  await writeFile(
    path.join(root, 'pkg', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/app.js dist/app.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } } }\n",
  )
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource(
      [plugin],
      `import { ${importName} } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
    ),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  return root
}

const OUT = path.join('pkg', 'dist', 'app.js')

async function coldAgain(root: string): Promise<void> {
  await rm(path.join(root, '.vx'), { recursive: true, force: true })
  await rm(path.join(root, 'pkg', 'dist'), { recursive: true, force: true })
}

for (const wire of ['turboCache', 'nxCache'] as const) {
  describe(`a hostile remote never breaks the run (${wire})`, () => {
    let srv: ReturnType<typeof hostileServer>
    let root: string
    beforeAll(async () => {
      srv = hostileServer()
      const decl =
        wire === 'turboCache'
          ? `turboCache({ apiUrl: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(TOKEN)}, timeoutMs: 700, uploadTimeoutMs: 700 })`
          : `nxCache({ server: ${JSON.stringify(srv.url)}, accessToken: ${JSON.stringify(TOKEN)}, timeoutMs: 700 })`
      root = await fixture(decl, wire)
    })
    afterAll(async () => {
      await srv.stop()
      await rm(root, { recursive: true, force: true })
    })

    it('CONTROL: with the server healthy the artifact round-trips through it', async () => {
      const first = await run({ cwd: root, tasks: ['build'], handleSignals: false })
      expect({ ok: first.ok, statuses: first.outcomes.map((o) => o.status) }).toEqual({
        ok: true,
        statuses: ['success'],
      })
      expect(srv.store.size).toBe(1)
      await coldAgain(root)
      const second = await run({ cwd: root, tasks: ['build'], handleSignals: false })
      expect({ ok: second.ok, statuses: second.outcomes.map((o) => o.status) }).toEqual({
        ok: true,
        statuses: ['cache-hit-remote'],
      })
    })

    it('a 500 on every request degrades to a miss — the task runs and the run is green', async () => {
      await coldAgain(root)
      srv.state.mode = 'error'
      try {
        const r = await run({ cwd: root, tasks: ['build'], handleSignals: false })
        expect({ ok: r.ok, statuses: r.outcomes.map((o) => o.status) }).toEqual({
          ok: true,
          statuses: ['success'],
        })
        expect(await Bun.file(path.join(root, OUT)).text()).toBe('console.log("app")\n')
      } finally {
        srv.state.mode = 'ok'
      }
    })

    it('a 401 degrades to a miss — the token is refused, the run is not', async () => {
      await coldAgain(root)
      srv.state.mode = 'unauthorized'
      try {
        const r = await run({ cwd: root, tasks: ['build'], handleSignals: false })
        expect({ ok: r.ok, statuses: r.outcomes.map((o) => o.status) }).toEqual({
          ok: true,
          statuses: ['success'],
        })
      } finally {
        srv.state.mode = 'ok'
      }
    })

    it('a server that never answers costs the deadline, not the run', async () => {
      await coldAgain(root)
      srv.state.mode = 'hang'
      const started = Date.now()
      try {
        const r = await run({ cwd: root, tasks: ['build'], handleSignals: false })
        expect({ ok: r.ok, statuses: r.outcomes.map((o) => o.status) }).toEqual({
          ok: true,
          statuses: ['success'],
        })
      } finally {
        srv.state.mode = 'ok'
      }
      // The claim is the configured 700 ms deadline, not the 30 s default:
      // a run that waited the default would be past this by 20×. The window
      // is wide enough for several deadlines (probe, get, put) in series.
      expect({ underTenSeconds: Date.now() - started < 10_000 }).toEqual({ underTenSeconds: true })
    })

    it('a corrupt artifact degrades to a miss — never a half-restored output', async () => {
      // Seed a real artifact, then serve garbage for it.
      srv.state.mode = 'ok'
      await coldAgain(root)
      await run({ cwd: root, tasks: ['build'], handleSignals: false })
      expect(srv.store.size).toBeGreaterThan(0)
      await coldAgain(root)
      srv.state.mode = 'corrupt'
      try {
        const r = await run({ cwd: root, tasks: ['build'], handleSignals: false })
        expect({ ok: r.ok, statuses: r.outcomes.map((o) => o.status) }).toEqual({
          ok: true,
          statuses: ['success'],
        })
        expect(await Bun.file(path.join(root, OUT)).text()).toBe('console.log("app")\n')
      } finally {
        srv.state.mode = 'ok'
      }
    })
  })
}

describe('a refused token costs ONE line on a whole workspace', () => {
  let srv: ReturnType<typeof hostileServer>
  let root: string
  beforeAll(async () => {
    srv = hostileServer()
    srv.state.mode = 'unauthorized'
    root = await mkdtemp(path.join(tmpdir(), 'vx-degrade-warn-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkgs/*'\n")
    for (const p of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await mkdir(path.join(root, 'pkgs', p, 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkgs', p, 'package.json'), JSON.stringify({ name: p }))
      await writeFile(path.join(root, 'pkgs', p, 'src', 'app.js'), `console.log("${p}")\n`)
      await writeFile(
        path.join(root, 'pkgs', p, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/app.js dist/app.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } } }\n",
      )
    }
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(
        [
          `turboCache({ apiUrl: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(TOKEN)}, timeoutMs: 700, uploadTimeoutMs: 700 })`,
        ],
        `import { turboCache } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
      ),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterAll(async () => {
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('six projects, one warning — what the adopter reads', async () => {
    // Through the CLI, because the line is stderr and the count is the
    // claim. `Bun.spawn`, never `spawnSync`: a parent that blocks its own
    // event loop cannot serve the stub the child is dialing, and the whole
    // first version of this probe read "The operation timed out" instead of
    // the 401 it was about (2026-09-20).
    const proc = Bun.spawn({
      cmd: [
        'bun',
        path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts'),
        'run',
        'build',
        '--all',
      ],
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    const warnings = `${out}${err}`.split('\n').filter((l) => l.includes('vx/turbo-cache:'))
    expect({ exitCode, warnings: warnings.length }).toEqual({ exitCode: 0, warnings: 1 })
    expect(warnings[0]).toMatch(/401.*token was refused/)
  })
})

const BIN = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')

/** `vx run build` through the CLI: the warnings are stderr lines, and their count is the claim. */
async function cliRun(
  root: string,
  prefix: string,
): Promise<{ exitCode: number; warnings: string[] }> {
  // `Bun.spawn`, never `spawnSync`: the stub the child dials lives in this
  // process's event loop.
  const proc = Bun.spawn({
    cmd: ['bun', BIN, 'run', 'build', '--all'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CI: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return {
    exitCode,
    warnings: `${out}${err}`.split('\n').filter((l) => l.includes(prefix)),
  }
}

for (const wire of ['turboCache', 'nxCache'] as const) {
  const prefix = wire === 'turboCache' ? 'vx/turbo-cache:' : 'vx/nx-cache:'
  // turborepo#487, #2096, #8772: a failed upload was silent, and the team
  // found out only when nothing ever hit.
  describe(`a refused or timed-out upload is said once and stores nothing (${wire})`, () => {
    let srv: ReturnType<typeof hostileServer>
    let root: string
    beforeAll(async () => {
      srv = hostileServer()
      const decl =
        wire === 'turboCache'
          ? `turboCache({ apiUrl: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(TOKEN)}, timeoutMs: 700, uploadTimeoutMs: 700 })`
          : `nxCache({ server: ${JSON.stringify(srv.url)}, accessToken: ${JSON.stringify(TOKEN)}, timeoutMs: 700 })`
      root = await fixture(decl, wire)
    })
    afterAll(async () => {
      await srv.stop()
      await rm(root, { recursive: true, force: true })
    })

    const upload = async (mode: 'put413' | 'puthang'): Promise<string[]> => {
      await coldAgain(root)
      srv.state.mode = mode
      let warnings: string[]
      try {
        const r = await cliRun(root, prefix)
        expect(r.exitCode).toBe(0)
        warnings = r.warnings
      } finally {
        srv.state.mode = 'ok'
      }
      expect(srv.store.size).toBe(0)
      await coldAgain(root)
      const next = await run({ cwd: root, tasks: ['build'], handleSignals: false })
      expect(next.outcomes.map((o) => o.status)).toEqual(['success'])
      srv.store.clear()
      return warnings
    }

    it('a 413: green, one warning naming the PUT, and the next cold run executes', async () => {
      const warnings = await upload('put413')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(new RegExp(`^${prefix} PUT [0-9a-f]+ → 413$`))
    })

    it('an upload past its deadline: green, one warning, and the next cold run executes', async () => {
      expect(await upload('puthang')).toEqual([`${prefix} The operation timed out.`])
    })
  })

  // turborepo#2081: an unreachable cache server was silent.
  describe(`an unreachable server degrades to a miss, out loud (${wire})`, () => {
    const unreachable = async (url: string): Promise<void> => {
      const decl =
        wire === 'turboCache'
          ? `turboCache({ apiUrl: ${JSON.stringify(url)}, token: ${JSON.stringify(TOKEN)}, timeoutMs: 700, uploadTimeoutMs: 700 })`
          : `nxCache({ server: ${JSON.stringify(url)}, accessToken: ${JSON.stringify(TOKEN)}, timeoutMs: 700 })`
      const root = await fixture(decl, wire)
      try {
        const r = await cliRun(root, prefix)
        expect(r.exitCode).toBe(0)
        expect(r.warnings.length).toBeGreaterThan(0)
        await coldAgain(root)
        const next = await run({ cwd: root, tasks: ['build'], handleSignals: false })
        expect({ ok: next.ok, statuses: next.outcomes.map((o) => o.status) }).toEqual({
          ok: true,
          statuses: ['success'],
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    it('a closed port: green, the task executes, and a warning says the remote failed', async () => {
      await unreachable('http://127.0.0.1:1')
    })

    it('a host that does not resolve: green, the task executes, and a warning says the remote failed', async () => {
      await unreachable('http://no-such-host.invalid')
    })
  })
}
