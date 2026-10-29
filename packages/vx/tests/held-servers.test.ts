// A server whose dependants a remote holds never starts (2026-10-22), as
// one behind local hits never does; one dependant the remote misses starts
// it before any of them is fetched.

import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { planRun, run } from './helpers/orchestrator.js'

function memoryRemote(): RemoteCacheLayer {
  const store = new Map<string, Uint8Array>()
  return {
    async has(hash) {
      return store.has(hash) ? {} : null
    },
    async hasMany(hashes) {
      return new Map(hashes.filter((h) => store.has(h)).map((h) => [h, {}]))
    },
    async get(hash) {
      // Slower than the run's local probe, so the prefetch has not filled
      // the local store when the run classifies its tasks.
      await Bun.sleep(300)
      const bytes = store.get(hash)
      return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: undefined }
    },
    async put(hash, body) {
      store.set(hash, new Uint8Array(await body.arrayBuffer()))
    },
  }
}

const test = (name: string) => `
      ${name}: {
        dependsOn: ['svc#srv'],
        exec: { command: 'cat ${name}.txt > ${name}.out' },
        inputs: { files: ['${name}.txt'] },
        cache: { outputs: { files: ['${name}.out'] } },
      },`

describe('a server behind remote hits', () => {
  let fixture: Fixture
  let dir: string
  let svc: string
  const started = () => existsSync(path.join(svc, 'started'))
  const runOnce = async (remote: RemoteCacheLayer) => {
    // Only the remote may answer, as on a fresh CI runner.
    await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
    await rm(path.join(svc, 'started'), { force: true })
    const r = await run({
      cwd: fixture.root,
      tasks: ['t1', 't2'],
      log: silentLogger(fixture),
      remoteCache: remote,
      remoteReadOnlyByDefault: false,
    })
    expect(r.ok).toBe(true)
    return new Map(
      r.outcomes.map((o) => [o.node.id, o.status.replace('cache-hit-remote', 'cache-hit')]),
    )
  }

  beforeEach(async () => {
    fixture = await makeWorkspace('vx-held-servers-')
    // In a project of its own: an uncached task may write its own project,
    // so a dependant beside it has no key until it has run.
    svc = await addProject(
      fixture.root,
      'svc',
      `
        export default {
          tasks: {
            srv: {
              exec: {
                command: 'touch started; echo READY; exec sleep 30',
                persistent: { readyWhen: 'READY' },
              },
              inputs: { files: ['srv.txt'] },
            },
          },
        }
      `,
    )
    await writeFile(path.join(svc, 'srv.txt'), 'srv')
    dir = await addProject(
      fixture.root,
      'app',
      `
        export default {
          tasks: {${test('t1')}${test('t2')}
          },
        }
      `,
    )
    for (const f of ['t1', 't2']) await writeFile(path.join(dir, `${f}.txt`), f)
  })
  afterEach(() => rm(fixture.root, { recursive: true, force: true }))

  it(
    'never starts when the remote holds every dependant',
    async () => {
      const remote = memoryRemote()
      expect(await runOnce(remote)).toEqual(
        new Map([
          ['svc#srv', 'success'],
          ['app#t1', 'success'],
          ['app#t2', 'success'],
        ]),
      )
      expect(started()).toBe(true)
      expect(await runOnce(remote)).toEqual(
        new Map([
          ['app#t1', 'cache-hit'],
          ['app#t2', 'cache-hit'],
        ]),
      )
      expect(started()).toBe(false)
    },
    TIMEOUT,
  )

  // `--dry` previews that run: it called the server `would exec` whenever
  // the hits were the remote's, not the local store's.
  it(
    '--dry says not started when the remote holds every dependant',
    async () => {
      const remote = memoryRemote()
      await runOnce(remote)
      await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
      const plan = await planRun({
        cwd: fixture.root,
        tasks: ['t1', 't2'],
        log: silentLogger(fixture),
        remoteCache: remote,
        remoteReadOnlyByDefault: false,
      })
      expect(plan.tasks.map((t) => `${t.node.id} ${t.cacheStatus}`).sort()).toEqual([
        'app#t1 hit-remote',
        'app#t2 hit-remote',
        'svc#srv not-started',
      ])
    },
    TIMEOUT,
  )

  it(
    '--dry says the server starts when the remote misses one dependant',
    async () => {
      const remote = memoryRemote()
      await runOnce(remote)
      await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
      await writeFile(path.join(dir, 't2.txt'), 'changed')
      const plan = await planRun({
        cwd: fixture.root,
        tasks: ['t1', 't2'],
        log: silentLogger(fixture),
        remoteCache: remote,
        remoteReadOnlyByDefault: false,
      })
      expect(plan.tasks.map((t) => `${t.node.id} ${t.cacheStatus}`).sort()).toEqual([
        'app#t1 hit-remote',
        'app#t2 miss',
        'svc#srv no-cache',
      ])
    },
    TIMEOUT,
  )

  it(
    'starts when the remote misses one dependant',
    async () => {
      const remote = memoryRemote()
      await runOnce(remote)
      await writeFile(path.join(dir, 't2.txt'), 'changed')
      const statuses = await runOnce(remote)
      expect([statuses.get('svc#srv'), statuses.get('app#t2')]).toEqual(['success', 'success'])
      expect(started()).toBe(true)
    },
    TIMEOUT,
  )
})
