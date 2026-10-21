// Task entries by key for a task another machine ran (`TaskArtifacts`):
// the machine that ran it saves its files and output under the order's
// key, the one that needs them restores them, and a restored key saved
// again is not uploaded twice.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, type RemoteCacheLayer } from '../src/cache/index.js'
import { taskArtifacts } from '../src/orchestrator/index.js'
import { layeredOver } from './helpers/layered.js'

let dir: string
const caches: Cache[] = []
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-task-artifacts-'))
})
afterEach(async () => {
  for (const c of caches.splice(0)) c.close()
  await rm(dir, { recursive: true, force: true })
})

function memoryRemote() {
  const store = new Map<string, Uint8Array>()
  let puts = 0
  const layer: RemoteCacheLayer = {
    async has(hash) {
      return store.has(hash) ? {} : null
    },
    async get(hash) {
      const b = store.get(hash)
      return b === undefined ? null : { body: new Blob([b.slice()]), durationMs: 5 }
    },
    async put(hash, body) {
      puts++
      store.set(hash, await body.bytes())
    },
  }
  return { layer, store, puts: () => puts }
}

/** A machine: its own checkout and cache, over the shared remote. */
async function machine(name: string, remote: RemoteCacheLayer) {
  const root = path.join(dir, name)
  await mkdir(path.join(root, 'app'), { recursive: true })
  const local = new Cache(path.join(root, '.vx', 'cache'), { read: true, write: true }, root)
  caches.push(local)
  return { root, artifacts: taskArtifacts(layeredOver(local, remote), root) }
}

const KEY = '0123456789abcdef'

it('restores a task another machine saved by its key: its files and its output, uploaded once', async () => {
  const remote = memoryRemote()
  const agent = await machine('agent', remote.layer)
  const task = (root: string) => ({
    id: 'app#build',
    projectDir: path.join(root, 'app'),
    command: 'build',
    outputs: { files: ['dist/**'], workspaceFiles: [] },
  })
  await mkdir(path.join(agent.root, 'app', 'dist'), { recursive: true })
  await writeFile(path.join(agent.root, 'app', 'dist', 'out.js'), 'built')
  await agent.artifacts.save(KEY, task(agent.root), {
    stdout: 'compiled\n',
    stderr: 'a warning\n',
    durationMs: 12,
  })
  expect(remote.puts()).toBe(1)

  const here = await machine('here', remote.layer)
  expect(await here.artifacts.restore('fedcba9876543210', task(here.root))).toBeNull()
  expect(await here.artifacts.restore(KEY, task(here.root))).toEqual({
    stdout: 'compiled\n',
    stderr: 'a warning\n',
  })
  expect(await readFile(path.join(here.root, 'app', 'dist', 'out.js'), 'utf8')).toBe('built')
  await here.artifacts.save(KEY, task(here.root), { stdout: '', stderr: '', durationMs: 12 })
  expect(remote.puts()).toBe(1)
})

it('masks a secret of the task env out of the stored output', async () => {
  const remote = memoryRemote()
  const agent = await machine('agent', remote.layer)
  const task = {
    id: 'app#t',
    projectDir: path.join(agent.root, 'app'),
    command: 'deploy',
    outputs: { files: [], workspaceFiles: [] },
  }
  const secret = 's3cr3t-value-for-test'
  await agent.artifacts.save(KEY, task, {
    stdout: `token ${secret}\n`,
    stderr: '',
    durationMs: 1,
    env: { DEPLOY_TOKEN: secret },
  })
  const here = await machine('here', remote.layer)
  const got = await here.artifacts.restore(KEY, {
    ...task,
    projectDir: path.join(here.root, 'app'),
  })
  expect(got?.stdout).not.toContain(secret)
})
