import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startServe } from '../src/cli/serve.js'
import { serveInfoPath } from '../src/serve-info.js'
import type { EnvironmentsFile } from '../src/environments.js'

// The connect/env/disconnect verbs are exercised through the REAL vx-cloud
// bin in a child process (async spawn, so an in-process startServe can answer
// the handshake), with VX_CLOUD_CONFIG pointed at a per-test temp file —
// nothing ever touches a real ~/.config.

const BIN = path.join(import.meta.dir, '..', 'src', 'cli', 'bin.ts')

// Isolate the per-user serve advertisement (written by startServe, read by
// `env ls`) at a temp path so these tests never collide with a real serve.
const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-envcli-${process.pid}.json`,
  )
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

let dir: string
let cfgPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-envcli-'))
  cfgPath = path.join(dir, 'environments.json')
  await rm(serveInfoPath(), { force: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: { ...process.env, VX_CLOUD_CONFIG: cfgPath },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function readCfg(): Promise<EnvironmentsFile> {
  return JSON.parse(await readFile(cfgPath, 'utf8')) as EnvironmentsFile
}

async function seedCfg(file: EnvironmentsFile): Promise<void> {
  await writeFile(cfgPath, JSON.stringify(file))
}

describe('vx-cloud connect', () => {
  it('validates against a live serve, persists the entry, and activates it', async () => {
    const server = await startServe({ root: dir })
    try {
      const res = await cli(['connect', server.origin, '--name', 'team', '--delegate'])
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('connected team')
      const file = await readCfg()
      expect(file.version).toBe(1)
      expect(file.active).toBe('team')
      expect(file.environments['team']).toEqual({ url: server.origin, delegate: true })
    } finally {
      await server.stop()
    }
  })

  it('--distribute persists the ambient-pool policy on the environment', async () => {
    const server = await startServe({ root: dir })
    try {
      const res = await cli(['connect', server.origin, '--name', 'pool', '--distribute'])
      expect(res.code).toBe(0)
      expect((await readCfg()).environments['pool']).toEqual({
        url: server.origin,
        distribute: true,
      })
    } finally {
      await server.stop()
    }
  })

  it('--distribute=<n> persists the advisory agent count', async () => {
    const server = await startServe({ root: dir })
    try {
      const res = await cli(['connect', server.origin, '--name', 'pool', '--distribute=4'])
      expect(res.code).toBe(0)
      expect((await readCfg()).environments['pool']).toEqual({
        url: server.origin,
        distribute: 4,
      })
    } finally {
      await server.stop()
    }
  })

  it('rejects a non-positive --distribute value', async () => {
    const server = await startServe({ root: dir })
    try {
      const res = await cli(['connect', server.origin, '--distribute=nope'])
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('invalid --distribute')
    } finally {
      await server.stop()
    }
  })

  it('--no-use persists without activating', async () => {
    const server = await startServe({ root: dir })
    try {
      const res = await cli(['connect', server.origin, '--name', 'aside', '--no-use'])
      expect(res.code).toBe(0)
      const file = await readCfg()
      expect(file.active).toBeUndefined()
      expect(file.environments['aside']!.url).toBe(server.origin)
    } finally {
      await server.stop()
    }
  })

  it('derives the name from the server identity (sanitized) when --name is absent', async () => {
    const server = await startServe({ root: dir, name: 'Conn Serve' })
    try {
      const res = await cli(['connect', server.origin])
      expect(res.code).toBe(0)
      const file = await readCfg()
      expect(file.active).toBe('conn-serve')
      expect(file.environments['conn-serve']!.url).toBe(server.origin)
    } finally {
      await server.stop()
    }
  })

  it('a token-requiring serve without --token errors with the fixit — nothing persisted', async () => {
    const server = await startServe({ root: dir, token: 'sekret' })
    try {
      const res = await cli(['connect', server.origin, '--name', 'gated'])
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('--token')
      expect(await Bun.file(cfgPath).exists()).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('a wrong token is rejected (401) — nothing persisted', async () => {
    const server = await startServe({ root: dir, token: 'sekret' })
    try {
      const res = await cli(['connect', server.origin, '--name', 'gated', '--token', 'wrong'])
      expect(res.code).toBe(1)
      expect(res.stderr).toMatch(/401/)
      expect(await Bun.file(cfgPath).exists()).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('the right token verifies and persists with the entry', async () => {
    const server = await startServe({ root: dir, token: 'sekret' })
    try {
      const res = await cli(['connect', server.origin, '--name', 'gated', '--token', 'sekret'])
      expect(res.code).toBe(0)
      const file = await readCfg()
      expect(file.environments['gated']).toEqual({ url: server.origin, token: 'sekret' })
    } finally {
      await server.stop()
    }
  })

  it('a dead URL errors — nothing persisted', async () => {
    const res = await cli(['connect', 'http://localhost:1', '--name', 'dead'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('cannot reach')
    expect(await Bun.file(cfgPath).exists()).toBe(false)
  })

  it('repointing an existing name at a different URL requires --force', async () => {
    const server = await startServe({ root: dir })
    try {
      await seedCfg({
        version: 1,
        active: 'team',
        environments: { team: { url: 'http://elsewhere.invalid' } },
      })
      const refused = await cli(['connect', server.origin, '--name', 'team'])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('--force')
      expect((await readCfg()).environments['team']!.url).toBe('http://elsewhere.invalid')

      const forced = await cli(['connect', server.origin, '--name', 'team', '--force'])
      expect(forced.code).toBe(0)
      expect((await readCfg()).environments['team']!.url).toBe(server.origin)
    } finally {
      await server.stop()
    }
  })
})

describe('vx-cloud env use / rm / disconnect', () => {
  it('use activates, rm deletes (clearing a pointing active), disconnect clears active only', async () => {
    await seedCfg({
      version: 1,
      active: 'a',
      environments: { a: { url: 'http://a.example' }, b: { url: 'http://b.example' } },
    })

    const used = await cli(['env', 'use', 'b'])
    expect(used.code).toBe(0)
    expect((await readCfg()).active).toBe('b')

    const missing = await cli(['env', 'use', 'nope'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('no environment named')

    const removed = await cli(['env', 'rm', 'b'])
    expect(removed.code).toBe(0)
    const afterRm = await readCfg()
    expect(afterRm.active).toBeUndefined()
    expect(afterRm.environments['b']).toBeUndefined()
    expect(afterRm.environments['a']).toBeDefined()

    await cli(['env', 'use', 'a'])
    const disconnected = await cli(['disconnect'])
    expect(disconnected.code).toBe(0)
    const afterDisconnect = await readCfg()
    expect(afterDisconnect.active).toBeUndefined()
    expect(afterDisconnect.environments['a']).toBeDefined()
  })
})

describe('vx-cloud env ls', () => {
  it('renders named envs + the synthetic (local) row, active marker, reachability — never tokens', async () => {
    const server = await startServe({ root: dir, name: 'ls-serve' })
    try {
      await seedCfg({
        version: 1,
        active: 'team',
        environments: {
          team: { url: server.origin, token: 'supersecret-token', delegate: true },
          dead: { url: 'http://localhost:1' },
        },
      })
      const res = await cli(['env', 'ls'])
      expect(res.code).toBe(0)
      // The live advertisement produces the synthetic first row.
      expect(res.stdout).toContain('(local)')
      expect(res.stdout).toContain('* team')
      expect(res.stdout).toContain('ok (ls-serve)')
      expect(res.stdout).toContain('unreachable')
      expect(res.stdout).toContain('yes')
      expect(res.stdout).not.toContain('supersecret-token')
    } finally {
      await server.stop()
    }
  })

  it('prints the connect hint when there is nothing to list', async () => {
    const res = await cli(['env', 'ls'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('no environments')
  })
})
