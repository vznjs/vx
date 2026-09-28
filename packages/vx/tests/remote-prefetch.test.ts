// `startRemotePrefetch` driven directly over a prepared run, with a layer
// that records what the pass asks of it. The e2e rows in
// `orchestrator-remote.test.ts` see the pass only through the wire, where
// execute-task's own lookups race it: its GETs overlap the pool's, and its
// context wins a pull the pass did not start. These rows see the pass alone
// (C-31).

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { CacheLayer } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun } from '../src/orchestrator/index.js'
import { startRemotePrefetch } from '../src/orchestrator/remote-prefetch.js'

const TIMEOUT = 30_000

const quiet: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

const CACHED = (command: string, outputs: string): string => `
  export default {
    tasks: {
      build: {
        exec: { command: ${JSON.stringify(command)} },
        cache: { inputs: { files: ['src/**'] }, outputs: ${outputs} },
      },
    },
  }
`

interface Recorded {
  prefetched: [string, Parameters<CacheLayer['prefetch']>[1]][]
  probed: string[][]
  maxInFlight: number
}

/**
 * The prepared cache with the three calls the pass makes answered here.
 * `present` undefined: the layer has no batch probe, so every stable key is
 * pulled. Each pull stays pending past a macrotask, so every pump the pass
 * starts is in flight at once before any settles.
 */
function recording(
  cache: CacheLayer,
  present?: (hashes: readonly string[]) => Set<string>,
): { layer: CacheLayer; rec: Recorded } {
  const rec: Recorded = { prefetched: [], probed: [], maxInFlight: 0 }
  let inFlight = 0
  const overrides: Partial<CacheLayer> = {
    async prefetch(hash, ctx) {
      rec.prefetched.push([hash, ctx])
      inFlight++
      rec.maxInFlight = Math.max(rec.maxInFlight, inFlight)
      await new Promise((r) => setImmediate(r))
      inFlight--
      return false
    },
    markRemoteAbsent() {},
    ...(present === undefined
      ? {}
      : {
          async remoteHasMany(hashes: readonly string[]) {
            rec.probed.push([...hashes])
            return present(hashes)
          },
        }),
  }
  const layer = new Proxy(cache, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof CacheLayer]
      if (prop === 'remoteHasMany') return undefined
      const v: unknown = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return { layer, rec }
}

describe('startRemotePrefetch', () => {
  let root: string

  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-prefetch-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function prefetchWith(
    concurrency: number,
    present?: (hashes: readonly string[]) => Set<string>,
    shape: (args: Parameters<typeof startRemotePrefetch>[0]) => typeof args = (a) => a,
  ): Promise<{ rec: Recorded; handle: Promise<void> }> {
    const prepared = await prepareRun({ cwd: root, tasks: ['build'], log: quiet }, quiet)
    const { layer, rec } = recording(prepared.cache, present)
    const handle = startRemotePrefetch(
      shape({
        nodes: prepared.nodes,
        cache: layer,
        workspaceRoot: prepared.workspaceRoot,
        workspaceFingerprint: prepared.workspaceFingerprint,
        nestedDirsByProject: prepared.nestedDirsByProject,
        gitFilesCache: prepared.gitFilesCache,
        hashCache: prepared.hashCache,
        concurrency,
        remoteRead: true,
      }),
    )
    // Settled before the close, whatever the handle does.
    await handle.then(
      () => {},
      () => {},
    )
    prepared.cache.close()
    return { rec, handle }
  }

  it(
    'keeps as many pulls in flight as the run has workers, and no more',
    async () => {
      for (const name of ['a', 'b', 'c']) {
        await addProject(root, name, {
          files: { 'src/in.txt': name },
          config: CACHED('echo built > out.txt', `{ files: ['out.txt'] }`),
        })
      }
      const two = await prefetchWith(2)
      expect(new Set(two.rec.prefetched.map(([h]) => h)).size).toBe(3)
      expect(two.rec.maxInFlight).toBe(2)
      // Control: the same three with four workers are all in flight at once.
      const four = await prefetchWith(4)
      expect(four.rec.prefetched).toHaveLength(3)
      expect(four.rec.maxInFlight).toBe(3)
    },
    TIMEOUT,
  )

  it(
    'tells the layer the task id, its command and both kinds of declared output',
    async () => {
      // The context is what a pulled artifact's entry row is written from and
      // the only names it may carry (item 942): an empty `workspaceFiles`
      // turns every remote hit of a task declaring one into a refused miss.
      await addProject(root, 'a', {
        files: { 'src/in.txt': 'a' },
        config: CACHED(
          'echo built > out.txt && echo g > ../../gen.txt',
          `{ files: ['out.txt'], workspaceFiles: ['gen.txt'] }`,
        ),
      })
      const { rec } = await prefetchWith(4)
      expect(rec.prefetched.map(([, ctx]) => ctx)).toEqual([
        {
          taskId: 'a#build',
          command: 'echo built > out.txt && echo g > ../../gen.txt',
          outputs: { files: ['out.txt'], workspaceFiles: ['gen.txt'] },
        },
      ])
    },
    TIMEOUT,
  )

  it(
    'with no stable key the remote is not asked at all',
    async () => {
      // An uncached task derives no key; a batch probe of nothing is a round
      // trip for no answer. Control: one cached task is probed.
      await addProject(
        root,
        'a',
        `
        export default { tasks: { build: { exec: { command: 'true' } } } }
      `,
      )
      const none = await prefetchWith(4, () => new Set())
      expect(none.rec.probed).toEqual([])
      expect(none.rec.prefetched).toEqual([])

      await addProject(root, 'b', {
        files: { 'src/in.txt': 'b' },
        config: CACHED('echo built > out.txt', `{ files: ['out.txt'] }`),
      })
      const one = await prefetchWith(4, () => new Set())
      expect(one.rec.probed.map((b) => b.length)).toEqual([1])
      expect(one.rec.prefetched).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a key derivation that throws leaves the handle resolved',
    async () => {
      // run() awaits the handle before it closes the cache, outside any
      // catch: a rejection there would end a run whose tasks all passed.
      await addProject(root, 'a', {
        files: { 'src/in.txt': 'a' },
        config: CACHED('echo built > out.txt', `{ files: ['out.txt'] }`),
      })
      let derived = 0
      const { rec, handle } = await prefetchWith(4, undefined, (args) => ({
        ...args,
        gitFilesCache: new Proxy(args.gitFilesCache, {
          get() {
            derived++
            throw new Error('git snapshot exploded')
          },
        }),
      }))
      const settled = await handle.then(
        (v) => ['resolved', v],
        (e: unknown) => ['rejected', String(e)],
      )
      expect(settled).toEqual(['resolved', undefined])
      expect(derived).toBe(1)
      expect(rec.prefetched).toEqual([])
    },
    TIMEOUT,
  )
})
