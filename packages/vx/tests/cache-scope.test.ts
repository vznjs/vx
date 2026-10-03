// `cacheScope`, end to end over an injected remote: the trusted scope reads
// and writes the task key; an untrusted scope reads the trusted key, then
// its own, and writes only its own; `read-only` writes nothing.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'

const BUILD_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/in.txt > out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
      },
    },
  }
`

function memoryRemote(): {
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  gets: string[]
} {
  const store = new Map<string, Uint8Array>()
  const gets: string[] = []
  const layer: RemoteCacheLayer = {
    async has(hash) {
      return store.has(hash)
    },
    async hasMany(hashes) {
      return new Set(hashes.filter((h) => store.has(h)))
    },
    async get(hash) {
      gets.push(hash)
      const bytes = store.get(hash)
      return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: undefined }
    },
    async put(hash, body) {
      store.set(hash, new Uint8Array(await body.arrayBuffer()))
    },
  }
  return { layer, store, gets }
}

async function runScoped(
  fixture: Fixture,
  remote: RemoteCacheLayer,
  scope: string | undefined,
  input: string,
): Promise<{ status: string; hash: string }> {
  await writeFile(
    path.join(fixture.root, 'vx.workspace.mjs'),
    scope === undefined ? `export default {}\n` : `export default { cacheScope: '${scope}' }\n`,
  )
  await writeFile(path.join(fixture.root, 'packages/app/src/in.txt'), input)
  // Only the remote may answer: every run starts from an empty local cache.
  await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })
  const result = await run({
    cwd: fixture.root,
    tasks: ['build'],
    log: silentLogger(fixture),
    remoteCache: remote,
  })
  expect(result.ok).toBe(true)
  const outcome = result.outcomes[0]!
  return { status: outcome.status, hash: outcome.hash! }
}

describe('cacheScope', () => {
  it(
    'a scope reads the trusted keys and its own, and writes only its own',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-')
      const { layer, store, gets } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        const main = await runScoped(fixture, layer, undefined, 'v1')
        expect(main.status).toBe('success')
        expect([...store.keys()]).toEqual([main.hash])

        // A PR reads what the default branch wrote, asking the trusted key first.
        gets.length = 0
        expect((await runScoped(fixture, layer, 'pr-1', 'v1')).status).toBe('cache-hit-remote')
        expect(gets).toEqual([main.hash])

        // Its own work lands beside the trusted key, never under it.
        const pr = await runScoped(fixture, layer, 'pr-1', 'v2')
        expect(pr.status).toBe('success')
        expect(store.size).toBe(2)
        expect(store.has(pr.hash)).toBe(false)

        // The same scope reads it back; another scope and trusted do not.
        expect((await runScoped(fixture, layer, 'pr-1', 'v2')).status).toBe('cache-hit-remote')
        expect((await runScoped(fixture, layer, 'pr-2', 'v2')).status).toBe('success')
        expect(store.size).toBe(3)
        const trusted = await runScoped(fixture, layer, 'trusted', 'v2')
        expect(trusted.status).toBe('success')
        expect(trusted.hash).toBe(pr.hash)
        expect(store.has(pr.hash)).toBe(true)
        expect(store.size).toBe(4)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'read-only reads the trusted keys and writes nothing',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-ro-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await runScoped(fixture, layer, undefined, 'v1')
        expect(store.size).toBe(1)
        expect((await runScoped(fixture, layer, 'read-only', 'v1')).status).toBe('cache-hit-remote')
        expect((await runScoped(fixture, layer, 'read-only', 'v2')).status).toBe('success')
        expect(store.size).toBe(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
