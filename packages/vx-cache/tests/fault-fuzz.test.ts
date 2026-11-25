// vx runs against a real @vzn/vx-cache-server whose every answer may fail:
// a 5xx or a 429, a body cut short or reset, a byte flipped, a check that
// says nothing JSON, an upload torn or stored short. Whatever the faults,
// every task ends green with the bytes a clean build makes, and nothing a
// fault damaged is ever restored, then or on a later run. Seeded:
// VX_FUZZ_SEED and VX_FUZZ_ROUNDS replay or widen a run.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { createCacheServer } from '@vzn/vx-cache-server'
import { run, silentLogger } from '@vzn/vx/testing'
import {
  ALLOW,
  GITHUB,
  type Issuer,
  issuer,
  MAIN_JOB,
  REPO,
  memBlobs,
} from '@vzn/vx-cache-server/testing'

const SEED = Number(Bun.env.VX_FUZZ_SEED ?? 1)
const ROUNDS = Number(Bun.env.VX_FUZZ_ROUNDS ?? 8)

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

const GET_FAULTS = ['ok', 'ok', '500', '503', '429', 'cut', 'reset', 'flip', 'stall'] as const
const CHECK_FAULTS = ['ok', 'ok', 'ok', '500', '429', 'html', 'garbage'] as const
const PUT_FAULTS = ['ok', 'ok', '500', '429', 'torn', 'short'] as const

let iss: Issuer
let root: string
let srv: ReturnType<typeof Bun.serve>
let url: string
const blobs = new Map<string, Uint8Array>()
const faults = { on: false, next: rng(SEED), seen: [] as string[] }
/**
 * Jobs that miss "at once": while `jobs` is set, a PUT waits until each of
 * that many jobs has asked for its hash, by GET and by check. Unheld, a job
 * slow to start on a loaded machine asked after another had uploaded, and hit.
 */
const race = {
  jobs: 0,
  asked: new Map<string, number>(),
  waiting: [] as { hash: string; go: () => void }[],
}

function asked(hash: string): void {
  race.asked.set(hash, (race.asked.get(hash) ?? 0) + 1)
  // Each job asks for a hash twice: its prefetch's GET and its check.
  const ready = (h: string) => (race.asked.get(h) ?? 0) >= race.jobs * 2
  for (const w of race.waiting.filter((w) => ready(w.hash))) w.go()
  race.waiting = race.waiting.filter((w) => !ready(w.hash))
}

function heard(hash: string): Promise<void> {
  if ((race.asked.get(hash) ?? 0) >= race.jobs * 2) return Promise.resolve()
  return new Promise((go) => race.waiting.push({ hash, go }))
}
const saved = { ...Bun.env }

const pick = <T>(all: readonly T[]): T => all[Math.floor(faults.next() * all.length)]!

/** A body whose stream errors after `at` bytes: the connection drops mid-answer. */
function resetAfter(bytes: Uint8Array, at: number): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) {
        sent = true
        c.enqueue(bytes.slice(0, at))
        return
      }
      c.error()
    },
  })
}

beforeAll(async () => {
  iss = await issuer()
  const handle = createCacheServer({
    blobs: memBlobs(blobs),
    authorize: oidcAuth({ allow: ALLOW, fetchJson: (u) => iss.fetchJson(u) }),
    limits: { maxUploadBytes: 8 << 20 },
  })
  srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: async (req) => {
      const p = new URL(req.url).pathname
      const kind =
        req.method === 'POST' ? 'check' : req.method === 'PUT' ? 'put' : req.method.toLowerCase()
      const fault = !faults.on
        ? 'ok'
        : kind === 'check'
          ? pick(CHECK_FAULTS)
          : kind === 'put'
            ? pick(PUT_FAULTS)
            : kind === 'get'
              ? pick(GET_FAULTS)
              : 'ok'
      faults.seen.push(`${kind}:${fault}`)
      if (race.jobs > 0) {
        const hash = p.slice('/v1/artifacts/'.length)
        if (kind === 'get' && p.startsWith('/v1/artifacts/')) asked(hash)
        if (kind === 'check')
          for (const h of ((await req.clone().json()) as { hashes: string[] }).hashes) asked(h)
        if (kind === 'put') await heard(hash)
      }
      if (fault === '500' || fault === '503' || fault === '429') {
        await req.arrayBuffer().catch(() => undefined)
        return new Response('{"message":"injected"}', { status: Number(fault) })
      }
      if (fault === 'html')
        return new Response('<html><title>502 Bad Gateway</title></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        })
      if (fault === 'garbage')
        return new Response('{"not', { headers: { 'content-type': 'application/json' } })
      if (kind === 'put' && fault === 'short') {
        // A server that stores an upload short and says it stored it.
        const bytes = new Uint8Array(await req.arrayBuffer())
        const headers = new Headers(req.headers)
        const kept = bytes.subarray(0, bytes.length >> 1)
        headers.set('content-length', String(kept.length))
        return handle(new Request(req.url, { method: 'PUT', headers, body: kept }) as never)
      }
      if (kind === 'put' && fault === 'torn') {
        // The connection drops after part of the body: nothing stored.
        const reader = req.body!.getReader()
        await reader.read()
        await reader.cancel().catch(() => undefined)
        return new Response('{"message":"torn"}', { status: 502 })
      }
      const res = await handle(req as never)
      if (kind !== 'get' || !p.startsWith('/v1/artifacts/') || res.status !== 200) return res
      const bytes = new Uint8Array(await res.arrayBuffer())
      const headers = new Headers(res.headers)
      headers.delete('content-length')
      if (fault === 'cut')
        return new Response(bytes.slice(0, Math.floor(bytes.length * faults.next())), { headers })
      if (fault === 'reset')
        return new Response(resetAfter(bytes, Math.floor(bytes.length * faults.next())), {
          headers,
        })
      if (fault === 'flip') {
        const m = bytes.slice()
        const at = Math.floor(m.length * faults.next())
        m[at] = m[at]! ^ (1 + Math.floor(faults.next() * 255))
        return new Response(m, { headers })
      }
      if (fault === 'stall')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes.slice(0, 16))
            },
          }),
          { headers },
        )
      return new Response(bytes, { headers })
    },
  })
  url = srv.url.href.replace(/\/$/, '')
  delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_URL
  delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  Bun.env.VX_CACHE_TOKEN = await iss.sign(MAIN_JOB, new URL(url).origin)
  root = await mkdtemp(path.join(tmpdir(), 'vx-cache-fuzz-'))
  // a → b → c, each output a text file and incompressible noise, so a
  // flipped byte can land in a stored zstd block.
  for (const [name, dep] of [
    ['a', undefined],
    ['b', 'a'],
    ['c', 'b'],
  ] as const) {
    await mkdir(path.join(root, name, 'src'), { recursive: true })
    await writeFile(path.join(root, name, 'src', 'in.txt'), `${name} 0\n`)
    await writeFile(
      path.join(root, name, 'package.json'),
      JSON.stringify({ name, ...(dep ? { dependencies: { [dep]: '*' } } : {}) }),
    )
    await writeFile(
      path.join(root, name, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: "mkdir -p dist && cp src/in.txt dist/out.txt && head -c 20000 /dev/urandom > dist/noise.bin && cat dist/out.txt" }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
    )
  }
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['a', 'b', 'c'] }),
  )
  await writeWorkspace(root, 500)
  Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: root })
  Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    cwd: root,
  })
})

afterAll(async () => {
  for (const k of Object.keys(Bun.env)) if (!(k in saved)) delete Bun.env[k]
  Object.assign(Bun.env, saved)
  await srv.stop(true)
  await rm(root, { recursive: true, force: true })
})

/** The workspace's plugin: short deadlines, so a stalled fault costs the fuzz little. */
function writeWorkspace(dir: string, uploadTimeoutMs: number): Promise<number> {
  return Bun.write(
    path.join(dir, '.vx/workspace.mjs'),
    `import { vxCache } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
      `export default { plugins: [vxCache({ url: ${JSON.stringify(url)}, issuer: ${JSON.stringify(GITHUB)}, repository: ${JSON.stringify(REPO)}, timeoutMs: 500, uploadTimeoutMs: ${uploadTimeoutMs}, retries: 1 })] }\n`,
  )
}

const cacheDir = () => path.join(root, '.vx', 'cache')

async function wipe(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true })
  for (const p of ['a', 'b', 'c'])
    await rm(path.join(root, p, 'dist'), { recursive: true, force: true })
}

/** Each project's out.txt says its input; noise.bin is whole (20,000 bytes). */
async function outputsRight(): Promise<void> {
  for (const p of ['a', 'b', 'c']) {
    const input = await readFile(path.join(root, p, 'src', 'in.txt'), 'utf8')
    expect(await readFile(path.join(root, p, 'dist', 'out.txt'), 'utf8')).toBe(input)
    expect((await readFile(path.join(root, p, 'dist', 'noise.bin'))).length).toBe(20000)
  }
}

it(
  `every task ends green with whole outputs under remote faults (seed ${SEED}, ${ROUNDS} rounds)`,
  async () => {
    const pick01 = rng(SEED ^ 0x5eed)
    for (let round = 0; round < ROUNDS; round++) {
      // An input moves now and then, so rounds both upload and download.
      if (pick01() < 0.4) {
        const p = ['a', 'b', 'c'][Math.floor(pick01() * 3)]!
        await writeFile(path.join(root, p, 'src', 'in.txt'), `${p} ${round}\n`)
      }
      await wipe()
      faults.on = true
      faults.seen = []
      const fx = { root, log: [] as string[], err: [] as string[] }
      const r = await run({
        cwd: root,
        tasks: ['build'],
        projects: ['a', 'b', 'c'],
        handleSignals: false,
        cacheDir: cacheDir(),
        log: silentLogger(fx),
      } as never)
      faults.on = false
      const statuses = r.outcomes.map((o) => o.status)
      const ok = statuses.every((s) => s === 'success' || s.startsWith('cache-hit'))
      if (!ok)
        console.error({ round, seed: SEED, statuses, seen: faults.seen, log: fx.log, err: fx.err })
      expect(statuses).toHaveLength(3)
      expect(ok).toBe(true)
      await outputsRight()
      // A clean read of what the remote holds: anything a fault stored is a
      // miss that runs, never wrong bytes.
      await wipe()
      const clean = await run({
        cwd: root,
        tasks: ['build'],
        projects: ['a', 'b', 'c'],
        handleSignals: false,
        cacheDir: cacheDir(),
        cache: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: false },
        log: silentLogger({ root, log: [], err: [] }),
      } as never)
      expect(
        clean.outcomes.every((o) => o.status === 'success' || o.status.startsWith('cache-hit')),
      ).toBe(true)
      await outputsRight()
    }
  },
  ROUNDS * 20_000,
)

/** `n` copies of the workspace: CI jobs on their own machines, under the same keys. */
async function jobs(n: number): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-cache-job-'))
    Bun.spawnSync({ cmd: ['cp', '-a', `${root}/.`, dir] })
    await rm(path.join(dir, '.vx', 'cache'), { recursive: true, force: true })
    for (const p of ['a', 'b', 'c'])
      await rm(path.join(dir, p, 'dist'), { recursive: true, force: true })
    out.push(dir)
  }
  return out
}

const runIn = (cwd: string, cache?: object) =>
  run({
    cwd,
    tasks: ['build'],
    projects: ['a', 'b', 'c'],
    handleSignals: false,
    cacheDir: path.join(cwd, '.vx', 'cache'),
    ...(cache ? { cache } : {}),
    log: silentLogger({ root: cwd, log: [], err: [] }),
  } as never)

it('jobs that miss the same keys at once all upload; a later job restores one whole artifact each', async () => {
  for (const p of ['a', 'b', 'c'])
    await writeFile(path.join(root, p, 'src', 'in.txt'), `${p} racing\n`)
  const racers = await jobs(6)
  // A held upload waits on the slowest job's lookups, not on its own deadline.
  for (const d of racers) await writeWorkspace(d, 60_000)
  const before = blobs.size
  try {
    race.jobs = racers.length
    const runs = await Promise.all(racers.map((d) => runIn(d))).finally(() => {
      race.jobs = 0
      race.asked.clear()
    })
    for (const r of runs)
      expect(r.outcomes.map((o) => o.status)).toEqual(['success', 'success', 'success'])
    // Uploads go on after the run's tasks; give them their time.
    for (let i = 0; i < 100 && blobs.size < before + 3; i++) await Bun.sleep(20)
    expect(blobs.size).toBe(before + 3)
    const [reader] = await jobs(1)
    racers.push(reader!)
    const r = await runIn(reader!, {
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: false,
    })
    expect(r.outcomes.map((o) => o.status)).toEqual([
      'cache-hit-remote',
      'cache-hit-remote',
      'cache-hit-remote',
    ])
    for (const p of ['a', 'b', 'c']) {
      expect(await readFile(path.join(reader!, p, 'dist', 'out.txt'), 'utf8')).toBe(`${p} racing\n`)
      expect((await readFile(path.join(reader!, p, 'dist', 'noise.bin'))).length).toBe(20000)
    }
  } finally {
    for (const d of racers) await rm(d, { recursive: true, force: true })
  }
})

it('runs sharing one machine cache restore the same remote artifacts at once, whole', async () => {
  // The remote holds every key (the test above); one cache dir, many workspaces.
  const racers = await jobs(6)
  const shared = path.join(await mkdtemp(path.join(tmpdir(), 'vx-cache-shared-')), 'cache')
  try {
    const runs = await Promise.all(
      racers.map((cwd) =>
        run({
          cwd,
          tasks: ['build'],
          projects: ['a', 'b', 'c'],
          handleSignals: false,
          cacheDir: shared,
          cache: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: false },
          log: silentLogger({ root: cwd, log: [], err: [] }),
        } as never),
      ),
    )
    for (const r of runs)
      for (const o of r.outcomes) expect(o.status.startsWith('cache-hit')).toBe(true)
    for (const d of racers)
      for (const p of ['a', 'b', 'c']) {
        expect(await readFile(path.join(d, p, 'dist', 'out.txt'), 'utf8')).toBe(`${p} racing\n`)
        expect((await readFile(path.join(d, p, 'dist', 'noise.bin'))).length).toBe(20000)
      }
    // And the shared store holds whole artifacts: a run with the remote off hits them all.
    const [last] = await jobs(1)
    racers.push(last!)
    const r = await run({
      cwd: last!,
      tasks: ['build'],
      projects: ['a', 'b', 'c'],
      handleSignals: false,
      cacheDir: shared,
      cache: { localRead: true, localWrite: false, remoteRead: false, remoteWrite: false },
      log: silentLogger({ root: last!, log: [], err: [] }),
    } as never)
    expect(r.outcomes.map((o) => o.status)).toEqual(['cache-hit', 'cache-hit', 'cache-hit'])
  } finally {
    for (const d of racers) await rm(d, { recursive: true, force: true })
    await rm(path.dirname(shared), { recursive: true, force: true })
  }
})
