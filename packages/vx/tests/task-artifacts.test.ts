// Task entries by key for a task another machine ran (`TaskArtifacts`):
// the machine that ran it saves its files and output under the order's
// key, the one that needs them restores them, and a restored key saved
// again is not uploaded twice.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, type RemoteCacheLayer } from '../src/cache/index.js'
import { cacheFacts, resolveCache, taskArtifacts } from '../src/orchestrator/index.js'
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

// A run whose tasks run on other machines hands them its facts: its refs,
// so they read as it does, and what its remotes lend, so one with no access
// of its own reaches the remote with the run's.
it('collects what each readable remote lends, by plugin, and the first end', async () => {
  const lending = (token: string, expiresAt?: number): RemoteCacheLayer => ({
    ...memoryRemote().layer,
    lend: async () => ({ token, ...(expiresAt === undefined ? {} : { expiresAt }) }),
  })
  const said: string[] = []
  const facts = await cacheFacts(
    [
      { remote: lending('a', 2000), plugin: 'pa', read: true, write: true },
      { remote: lending('b', 1000), plugin: 'pb', read: true, write: false },
      { remote: lending('off'), plugin: 'pc', read: false, write: false },
      { remote: lending('injected'), read: true, write: true },
      {
        remote: { ...memoryRemote().layer, lend: () => Promise.reject(new Error('down')) },
        plugin: 'pd',
        read: true,
        write: true,
        onError: (e) => said.push(e.message),
      },
      { remote: memoryRemote().layer, plugin: 'pe', read: true, write: true },
    ],
    ['refs/heads/feat', 'refs/heads/main'],
  )
  expect(facts).toEqual({
    refs: ['refs/heads/feat', 'refs/heads/main'],
    lent: { pa: 'a', pb: 'b' },
    expiresAt: 1000,
  })
  // One that cannot lend is said: unsaid, the run's workers went without it.
  expect(said).toEqual(["lend of pd's access failed: down"])
})

it('gives each cache plugin the token lent to it, read when asked', async () => {
  const local = new Cache(path.join(dir, '.vx', 'cache'), { read: true, write: true }, dir)
  caches.push(local)
  const seen: (string | undefined)[] = []
  const plugin = (name: string) => ({
    name,
    cache(ctx: { lent?: () => string | undefined }) {
      return { ...memoryRemote().layer, has: async () => (seen.push(ctx.lent?.()), null) }
    },
  })
  let lent: Record<string, string> = { a: 'ta' }
  const layer = await resolveCache([plugin('a'), plugin('b')] as never, {
    workspaceRoot: dir,
    cacheDir: path.join(dir, '.vx', 'cache'),
    warn() {},
    scope: undefined,
    refs: [],
    localCache: local,
    policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
    remotes: [],
    lentBy: () => lent,
  })
  await layer.has(KEY)
  lent = { a: 'ta2', b: 'tb' }
  await layer.has(KEY)
  expect(seen).toEqual(['ta', undefined, 'ta2', 'tb'])
})

it('output resolves the output alone and lays no file', async () => {
  // A remote-only task's files stay off the run's machine; its output does not.
  const remote = memoryRemote()
  const agent = await machine('agent', remote.layer)
  const task = {
    id: 'app#install',
    projectDir: path.join(agent.root, 'app'),
    command: 'install',
    outputs: { files: ['node_modules/**'], workspaceFiles: [] },
  }
  await mkdir(path.join(agent.root, 'app', 'node_modules'), { recursive: true })
  await writeFile(path.join(agent.root, 'app', 'node_modules', 'x.js'), 'x')
  await agent.artifacts.save(KEY, task, { stdout: 'installed\n', stderr: '', durationMs: 3 })
  const here = await machine('here', remote.layer)
  expect(await here.artifacts.output(KEY)).toEqual({ stdout: 'installed\n', stderr: '' })
  expect(await Bun.file(path.join(here.root, 'app', 'node_modules', 'x.js')).exists()).toBe(false)
})

it('leaves the files a task names as others out of its entry', async () => {
  const remote = memoryRemote()
  const agent = await machine('agent', remote.layer)
  const task = (root: string, others?: Set<string>) => ({
    id: 'app#add',
    projectDir: path.join(root, 'app'),
    command: 'add',
    outputs: { files: ['dist/**'], workspaceFiles: [] },
    ...(others === undefined ? {} : { others }),
  })
  const dist = path.join(agent.root, 'app', 'dist')
  await mkdir(dist, { recursive: true })
  await writeFile(path.join(dist, 'up.js'), 'upstream')
  await writeFile(path.join(dist, 'mine.js'), 'mine')
  await agent.artifacts.save(KEY, task(agent.root, new Set([path.join(dist, 'up.js')])), {
    stdout: '',
    stderr: '',
    durationMs: 1,
  })
  const here = await machine('here', remote.layer)
  await here.artifacts.restore(KEY, task(here.root))
  const there = path.join(here.root, 'app', 'dist')
  expect([
    await Bun.file(path.join(there, 'mine.js')).exists(),
    await Bun.file(path.join(there, 'up.js')).exists(),
  ]).toEqual([true, false])
})
