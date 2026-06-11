import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

interface Fixture {
  root: string
  log: string[]
  err: string[]
}

const TIMEOUT = 30_000

const silentLogger = (fixture: Fixture): Logger => {
  const buffers = new Map<string, string>()
  return {
    status(line) {
      fixture.log.push(line)
    },
    taskStdout(node, chunk) {
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskStderr(node, chunk) {
      fixture.err.push(chunk.trimEnd())
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      fixture.log.push(`task ${node.id} ${outcome.status}`)
      if (body.trim().length > 0) fixture.log.push(body.trimEnd())
    },
  }
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-remote-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  initGitRepo(root)
  return { root, log: [], err: [] }
}

function initGitRepo(cwd: string): void {
  const git = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
}

async function addProject(
  root: string,
  name: string,
  args: { files?: Record<string, string>; config: string },
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

/** Minimal in-memory Turbo /v8/artifacts server. */
function startArtifactServer(): {
  server: ReturnType<typeof Bun.serve>
  baseUrl: string
  store: Map<string, Uint8Array>
  tags: Map<string, string>
} {
  const store = new Map<string, Uint8Array>()
  const tags = new Map<string, string>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const m = url.pathname.match(/^\/v8\/artifacts\/([0-9a-f]+)$/)
      if (!m) return new Response('not found', { status: 404 })
      const hash = m[1]!
      if (req.method === 'PUT') {
        store.set(hash, new Uint8Array(await req.arrayBuffer()))
        const tag = req.headers.get('x-artifact-tag')
        if (tag) tags.set(hash, tag)
        return new Response(JSON.stringify({ urls: [] }), { status: 200 })
      }
      if (req.method === 'GET') {
        const body = store.get(hash)
        if (!body) return new Response('not found', { status: 404 })
        const headers: Record<string, string> = { 'x-artifact-duration': '12' }
        const tag = tags.get(hash)
        if (tag) headers['x-artifact-tag'] = tag
        return new Response(body, { status: 200, headers })
      }
      return new Response('method not allowed', { status: 405 })
    },
  })
  return { server, baseUrl: `http://localhost:${server.port}`, store, tags }
}

describe('orchestrator e2e: remote cache', () => {
  let fixture: Fixture
  let remote: ReturnType<typeof startArtifactServer>
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    fixture = await makeWorkspace()
    remote = startArtifactServer()
    for (const k of [
      'VX_REMOTE_CACHE_URL',
      'VX_REMOTE_CACHE_TOKEN',
      'VX_REMOTE_CACHE_SIGNATURE_KEY',
    ]) {
      savedEnv[k] = process.env[k]
    }
    process.env.VX_REMOTE_CACHE_URL = remote.baseUrl
    process.env.VX_REMOTE_CACHE_TOKEN = 'test-token'
    delete process.env.VX_REMOTE_CACHE_SIGNATURE_KEY
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await remote.server.stop(true)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a run served entirely from the remote layer reports ok: true',
    async () => {
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const first = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]!.status).toBe('success')
      // Write-through upload landed on the remote.
      expect(remote.store.size).toBe(1)

      // Wipe the local cache so the only source of truth is the remote.
      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      const second = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
      expect(second.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'VX_REMOTE_CACHE_SIGNATURE_KEY signs uploads and verifies downloads end-to-end',
    async () => {
      process.env.VX_REMOTE_CACHE_SIGNATURE_KEY = 'e2e-signing-key-0123456789abcdef'
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const first = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(first.ok).toBe(true)
      // The upload carried an x-artifact-tag.
      expect(remote.tags.size).toBe(1)

      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      // Round trip: the tagged artifact passes verification on the way back.
      const second = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(second.outcomes[0]!.status).toBe('cache-hit-remote')

      // Tamper the stored artifact: verification fails, the run degrades
      // to re-execution instead of restoring poisoned bytes.
      const [hash, body] = [...remote.store.entries()][0]!
      const flipped = new Uint8Array(body)
      flipped[0] = flipped[0]! ^ 0xff
      remote.store.set(hash, flipped)
      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      const third = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(third.ok).toBe(true)
      expect(third.outcomes[0]!.status).toBe('success')
      expect(fixture.log.join('\n')).toMatch(/signature mismatch/)
    },
    TIMEOUT,
  )
})
