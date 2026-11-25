// turboCache() and nxCache() on a real `vx run` against a server whose every
// answer may fail at random: a 5xx or a 429, a body cut short (with or
// without its length), reset or stalled, a byte flipped, an upload torn or
// stored short, a query answered with no JSON. Every task ends green with
// the bytes a clean build makes, and a clean read of what the server holds
// never restores what a fault damaged. Seeded: VX_FUZZ_SEED and
// VX_FUZZ_ROUNDS replay or widen a run.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { silentLogger } from '../../vx/tests/helpers/orchestrator-fixture.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const SEED = Number(Bun.env.VX_FUZZ_SEED ?? 1)
const ROUNDS = Number(Bun.env.VX_FUZZ_ROUNDS ?? 4)
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const PROJECTS = ['a', 'b', 'c']

/** mulberry32: a seed replays a run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const GET_FAULTS = [
  'ok',
  'ok',
  '500',
  '503',
  '429',
  'cut',
  'cut-len',
  'reset',
  'flip',
  'stall',
] as const
const QUERY_FAULTS = ['ok', 'ok', '500', '429', 'garbage'] as const
const PUT_FAULTS = ['ok', 'ok', '500', '429', 'torn', 'short'] as const

/** One store under both wires, every answer drawn from `next` while `on`. */
function faultyServer(seed: number) {
  const store = new Map<string, Uint8Array>()
  const state = { on: false, next: rng(seed), seen: [] as string[] }
  const pick = <T>(all: readonly T[]): T => all[Math.floor(state.next() * all.length)]!
  const hashOf = (p: string) => /^\/(?:v8\/artifacts|v1\/cache)\/([0-9a-z]+)$/.exec(p)?.[1]
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const hash = hashOf(url.pathname)
      const kind = hash === undefined ? 'query' : req.method.toLowerCase()
      const fault = !state.on
        ? 'ok'
        : kind === 'query'
          ? pick(QUERY_FAULTS)
          : kind === 'put'
            ? pick(PUT_FAULTS)
            : kind === 'get'
              ? pick(GET_FAULTS)
              : 'ok'
      state.seen.push(`${req.method} ${url.pathname.split('/').slice(0, 3).join('/')}:${fault}`)
      if (fault === '500' || fault === '503' || fault === '429') {
        // quiet: the body is dropped with the answer
        await req.arrayBuffer().catch(() => undefined)
        return new Response('injected', { status: Number(fault) })
      }
      if (hash === undefined) {
        if (fault === 'garbage')
          return new Response('{"not', { headers: { 'content-type': 'application/json' } })
        if (req.method === 'POST' && url.pathname === '/v8/artifacts') {
          const { hashes } = (await req.json()) as { hashes: string[] }
          return Response.json(Object.fromEntries(hashes.map((h) => [h, store.has(h) ? {} : null])))
        }
        return new Response('not found', { status: 404 })
      }
      if (req.method === 'PUT') {
        if (fault === 'torn') {
          const reader = req.body!.getReader()
          await reader.read()
          // quiet: the upload is torn on purpose
          await reader.cancel().catch(() => undefined)
          return new Response('torn', { status: 502 })
        }
        const bytes = new Uint8Array(await req.arrayBuffer())
        store.set(hash, fault === 'short' ? bytes.slice(0, bytes.length >> 1) : bytes)
        return new Response(null, { status: 202 })
      }
      const held = store.get(hash)
      if (held === undefined) return new Response('not found', { status: 404 })
      if (req.method === 'HEAD')
        return new Response(null, { headers: { 'content-length': String(held.length) } })
      if (fault === 'cut')
        return new Response(held.slice(0, Math.floor(held.length * state.next())))
      if (fault === 'cut-len') {
        // Its length named whole, its bytes cut: the connection closes early.
        let sent = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent) return c.error()
              sent = true
              c.enqueue(held.slice(0, Math.floor(held.length * state.next())))
            },
          }),
          { headers: { 'content-length': String(held.length) } },
        )
      }
      if (fault === 'reset') {
        let sent = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent) return c.error()
              sent = true
              c.enqueue(held.slice(0, Math.floor(held.length * state.next())))
            },
          }),
        )
      }
      if (fault === 'flip') {
        const m = held.slice()
        const at = Math.floor(m.length * state.next())
        m[at] = m[at]! ^ (1 + Math.floor(state.next() * 255))
        return new Response(m)
      }
      if (fault === 'stall')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(held.slice(0, 16))
            },
          }),
        )
      return new Response(held)
    },
  })
  return { store, state, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function fixture(decl: string, importName: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-fault-fuzz-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "*"\n')
  for (const p of PROJECTS) {
    await mkdir(path.join(root, p, 'src'), { recursive: true })
    await writeFile(path.join(root, p, 'package.json'), JSON.stringify({ name: p }))
    await writeFile(path.join(root, p, 'src', 'in.txt'), `${p} 0\n`)
    await writeFile(
      path.join(root, p, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: "mkdir -p dist && cp src/in.txt dist/out.txt && head -c 20000 /dev/urandom > dist/noise.bin" }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
    )
  }
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([decl], `import { ${importName} } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  return root
}

for (const wire of ['turboCache', 'nxCache'] as const) {
  describe(`${wire} under random faults`, () => {
    let srv: ReturnType<typeof faultyServer>
    let root: string
    beforeAll(async () => {
      srv = faultyServer(SEED)
      const opts = `url: ${JSON.stringify(srv.url)}, token: 'tok', timeoutMs: 500, retries: 1`
      root = await fixture(
        wire === 'turboCache'
          ? `turboCache({ ${opts}, uploadTimeoutMs: 500 })`
          : `nxCache({ ${opts} })`,
        wire,
      )
    })
    afterAll(async () => {
      await srv.stop()
      await rm(root, { recursive: true, force: true })
    })

    const cacheDir = () => path.join(root, '.vx', 'cache')
    async function wipe(): Promise<void> {
      await rm(cacheDir(), { recursive: true, force: true })
      for (const p of PROJECTS)
        await rm(path.join(root, p, 'dist'), { recursive: true, force: true })
    }
    async function outputsRight(): Promise<void> {
      for (const p of PROJECTS) {
        const input = await readFile(path.join(root, p, 'src', 'in.txt'), 'utf8')
        expect(await readFile(path.join(root, p, 'dist', 'out.txt'), 'utf8')).toBe(input)
        expect((await readFile(path.join(root, p, 'dist', 'noise.bin'))).length).toBe(20000)
      }
    }
    const runOnce = (log: string[], cache?: object) =>
      run({
        cwd: root,
        tasks: ['build'],
        projects: PROJECTS,
        handleSignals: false,
        cacheDir: cacheDir(),
        ...(cache ? { cache } : {}),
        log: silentLogger({ root, log, err: [] }),
      } as never)

    it(
      `every task ends green with whole outputs (seed ${SEED}, ${ROUNDS} rounds)`,
      async () => {
        const draw = rng(SEED ^ 0x5eed)
        for (let round = 0; round < ROUNDS; round++) {
          if (draw() < 0.4) {
            const p = PROJECTS[Math.floor(draw() * 3)]!
            await writeFile(path.join(root, p, 'src', 'in.txt'), `${p} ${round}\n`)
          }
          await wipe()
          srv.state.on = true
          srv.state.seen = []
          const log: string[] = []
          const r = await runOnce(log)
          srv.state.on = false
          const statuses = r.outcomes.map((o) => o.status)
          const ok =
            statuses.length === 3 &&
            statuses.every((s) => s === 'success' || s.startsWith('cache-hit'))
          if (!ok) console.error({ wire, round, seed: SEED, statuses, seen: srv.state.seen, log })
          expect(ok).toBe(true)
          await outputsRight()
          await wipe()
          const clean = await runOnce([], {
            localRead: true,
            localWrite: true,
            remoteRead: true,
            remoteWrite: true,
          })
          expect(
            clean.outcomes.every((o) => o.status === 'success' || o.status.startsWith('cache-hit')),
          ).toBe(true)
          await outputsRight()
        }
      },
      ROUNDS * 20_000,
    )
  })
}
