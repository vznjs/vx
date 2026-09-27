// Item 944: a remote layer's `durationMs` reached the entry row unchecked.
// A NaN failed the row's NOT NULL after the artifact was renamed into
// place, so a valid hit was thrown away (the task ran) and its bytes were
// orphaned; a negative, infinite or huge one was stored and replayed.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'

const CFG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } }`

it(
  'a remote duration that is no usable count of ms is a hit recorded as 0 ms',
  async () => {
    const fx = await makeWorkspace('vx-duration-')
    try {
      await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
      let stored: Uint8Array | undefined
      let duration = 1
      const remote: RemoteCacheLayer = {
        endpoint: 'mem://test',
        async has() {
          return stored !== undefined
        },
        async get() {
          return stored === undefined ? null : { body: new Blob([stored]), durationMs: duration }
        },
        async put(_hash, body) {
          stored = new Uint8Array(await body.arrayBuffer())
        },
      }
      const log = silentLogger(fx)
      await run({ cwd: fx.root, tasks: ['build'], log, remoteCache: remote })
      const seen: Record<string, [string, number | undefined]> = {}
      for (const d of [Number.NaN, Infinity, -5, 1e300, 1.7]) {
        duration = d
        await rm(path.join(fx.root, '.vx'), { recursive: true, force: true })
        const r = await run({ cwd: fx.root, tasks: ['build'], log, remoteCache: remote })
        seen[String(d)] = [r.outcomes[0]!.status, r.outcomes[0]!.storedDurationMs]
      }
      expect(seen).toEqual({
        NaN: ['cache-hit-remote', 0],
        Infinity: ['cache-hit-remote', 0],
        '-5': ['cache-hit-remote', 0],
        '1e+300': ['cache-hit-remote', 0],
        '1.7': ['cache-hit-remote', 2],
      })
    } finally {
      await rm(fx.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
