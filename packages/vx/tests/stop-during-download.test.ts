// A stop while a remote read is in flight ends the run without waiting on
// it. A Ctrl-C during a slow download waited for the whole body, showed a
// blank screen, then printed every task as a success (2026-10-17).
import { rm } from 'node:fs/promises'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { run } from './helpers/orchestrator.js'

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
      },
    },
  }
`

/** A body that sends one chunk and then never another. */
const endless = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(64 * 1024))
      },
    }),
    { headers: { 'content-length': String(64 * 1024 * 1024) } },
  )

for (const [name, answer] of [
  ['a lookup that never answers', () => new Promise<never>(() => {})],
  ['a download that never ends', async () => ({ body: endless(), durationMs: 1 })],
] as const) {
  it(
    `a run stopped during ${name} returns at once, every task aborted`,
    async () => {
      const fixture = await makeWorkspace('vx-stop-download-')
      try {
        for (const p of ['a', 'b']) {
          await addProject(fixture.root, p, { files: { 'src/in.txt': p }, config: CONFIG })
        }
        const controller = new AbortController()
        const layer: RemoteCacheLayer = {
          has: async () => ({}),
          get: () => {
            setTimeout(() => controller.abort('SIGINT'), 50)
            return answer()
          },
          put: async () => {},
        }
        const started = performance.now()
        const result = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: layer,
          signal: controller.signal,
        })
        expect(performance.now() - started).toBeLessThan(5_000)
        expect(result.ok).toBe(false)
        expect(result.outcomes.map((o) => o.status)).toEqual(['aborted', 'aborted'])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
}
