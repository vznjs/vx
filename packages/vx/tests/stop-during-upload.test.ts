// A stop while an upload is in flight ends the run without waiting on it. A
// plugin's put cannot be cancelled, so the drain waited it out: a slow remote
// held a SIGTERMed run past the signal's exit bound, which then exited with
// no footer (bug hunt round 3, 2026-10-15). Queued uploads never start.
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

it(
  'a run stopped mid-upload returns at once and starts no queued upload',
  async () => {
    const fixture = await makeWorkspace('vx-stop-upload-')
    // The `.tar.zst` form: its first upload starts while the other tasks
    // still run, so the stop also aborts them.
    process.env.VX_CACHE_STORE_DECOMPRESS = 'false'
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
        await addProject(fixture.root, name, { files: { 'src/in.txt': name }, config: CONFIG })
      }
      const controller = new AbortController()
      let puts = 0
      const layer: RemoteCacheLayer = {
        has: async () => false,
        get: async () => null,
        // Never answers: a remote that hangs on every upload.
        put: () => {
          puts++
          controller.abort('SIGTERM')
          return new Promise<void>(() => {})
        },
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
      // Four upload slots: the queue behind the first never starts.
      expect(puts).toBeLessThanOrEqual(4)
    } finally {
      delete process.env.VX_CACHE_STORE_DECOMPRESS
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
