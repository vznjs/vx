// A remote hit whose body would take longer than running the task is given
// up, and the task runs here. The batch probe's size and stored duration
// are the judge's facts; a key the remote did not size or time is awaited.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import type { ArtifactInfo, RemoteCacheLayer } from '../src/cache/index.js'
import { run } from './helpers/orchestrator.js'

const CFG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } } } } }`

/** `bytes` as a body: its first `share` now (half), the rest after `gapMs`, or never. */
const trickle = (bytes: Uint8Array, gapMs: number | null, share = 0.5): Response => {
  const half = Math.floor(bytes.length * share)
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(bytes.slice(0, half))
        if (gapMs === null) return
        await Bun.sleep(gapMs)
        c.enqueue(bytes.slice(half))
        c.close()
      },
    }),
  )
}

for (const [name, info, gapMs, status, share] of [
  ['a body slower than the task runs the task here', 'huge', null, 'success', 0.5],
  ['a body faster than the task is awaited', 'slow-task', 300, 'cache-hit-remote', 0.5],
  ['a key the remote did not size is awaited', 'none', 300, 'cache-hit-remote', 0.5],
  // Turbo's wire rounds a sub-ms task to 0: its budget was 0, and a body
  // 99% in at the first weighing was given up for its last bytes.
  [
    'a body nearly in is awaited for a task timed at 0 ms',
    'instant',
    200,
    'cache-hit-remote',
    0.99,
  ],
] as const) {
  it(
    name,
    async () => {
      const fx = await makeWorkspace('vx-slow-download-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        let stored: Uint8Array | undefined
        let puts = 0
        const infoOf = (): ArtifactInfo =>
          info === 'huge'
            ? { size: stored!.length * 1000, durationMs: 1 }
            : info === 'slow-task'
              ? { size: stored!.length, durationMs: 60_000 }
              : info === 'instant'
                ? { size: stored!.length, durationMs: 0 }
                : {}
        const remote: RemoteCacheLayer = {
          endpoint: 'mem://test',
          has: async () => (stored === undefined ? null : infoOf()),
          // A late answer: the task asks for its body before the probe says.
          hasMany: async (hs) => {
            await Bun.sleep(100)
            return new Map(stored === undefined ? [] : hs.map((h) => [h, infoOf()] as const))
          },
          get: async () =>
            stored === undefined ? null : { body: trickle(stored, gapMs, share), durationMs: 1 },
          put: async (_hash, body) => {
            puts++
            stored = new Uint8Array(await body.arrayBuffer())
          },
        }
        const log = silentLogger(fx)
        await run({ cwd: fx.root, tasks: ['build'], log, remoteCache: remote })
        expect(puts).toBe(1)
        await rm(path.join(fx.root, '.vx', 'cache'), { recursive: true, force: true })
        const started = performance.now()
        const r = await run({ cwd: fx.root, tasks: ['build'], log, remoteCache: remote })
        expect(r.outcomes.map((o) => o.status)).toEqual([status])
        expect(performance.now() - started).toBeLessThan(5_000)
        // The remote holds the key: a task run instead of its download uploads nothing.
        expect(puts).toBe(1)
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
}
