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
  // Interleaved, as a run writes it: a replay keeps the order.
  const output = [
    { text: 'compiling\n', err: false },
    { text: 'a warning\n', err: true },
    { text: 'compiled\n', err: false },
  ]
  await agent.artifacts.save(KEY, task(agent.root), { output, durationMs: 12 })
  expect(remote.puts()).toBe(1)

  const here = await machine('here', remote.layer)
  expect(await here.artifacts.restore('fedcba9876543210', task(here.root))).toBeNull()
  expect(await here.artifacts.restore(KEY, task(here.root))).toEqual(output)
  expect(await readFile(path.join(here.root, 'app', 'dist', 'out.js'), 'utf8')).toBe('built')
  await here.artifacts.save(KEY, task(here.root), { output: [], durationMs: 12 })
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
    output: [{ text: `token ${secret}\n`, err: false }],
    durationMs: 1,
    env: { DEPLOY_TOKEN: secret },
  })
  const here = await machine('here', remote.layer)
  const got = await here.artifacts.restore(KEY, {
    ...task,
    projectDir: path.join(here.root, 'app'),
  })
  expect(got?.[0]?.text).toBe('token ***\n')
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

// `lend` is a plugin's: a synchronous throw skipped the `.catch` and
// rejected the whole answer, and a `null` or a numeric token met `.token`
// as a TypeError, so no remote's access reached the workers.
it('a lend that throws at once, or answers no token, lends nothing and is said', async () => {
  const said: string[] = []
  const remote = (lend: unknown, plugin: string) => ({
    remote: { ...memoryRemote().layer, lend } as RemoteCacheLayer,
    plugin,
    read: true,
    write: true,
    onError: (e: Error) => said.push(e.message),
  })
  const facts = await cacheFacts(
    [
      remote(() => {
        throw new Error('no session')
      }, 'pa'),
      remote(async () => null, 'pb'),
      remote(async () => ({ token: 5 }), 'pc'),
      remote(async () => ({ token: 'ok', expiresAt: 'soon' }), 'pd'),
      remote(async () => ({ token: 'fine', expiresAt: 900 }), 'pe'),
    ],
    [],
  )
  expect(facts).toEqual({ refs: [], lent: { pe: 'fine' }, expiresAt: 900 })
  expect(said).toEqual([
    "lend of pa's access failed: no session",
    "lend of pb's access failed: it answered null, not { token, expiresAt? }",
    "lend of pc's access failed: it answered a token that is not a string",
    "lend of pd's access failed: it answered an expiresAt that is not a time in ms",
  ])
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
  await agent.artifacts.save(KEY, task, {
    output: [{ text: 'installed\n', err: false }],
    durationMs: 3,
  })
  const here = await machine('here', remote.layer)
  expect(await here.artifacts.output(KEY)).toEqual([{ text: 'installed\n', err: false }])
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
    output: [],
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

// A DTE worker restores a dependency from the remotes alone: a hit only
// this machine's cache held (the remote evicted it, or this run did not
// write) failed its dependant there.
it('share uploads an entry only this machine holds, and only that one', async () => {
  const remote = memoryRemote()
  const here = await machine('here', remote.layer)
  const task = (root: string) => ({
    id: 'app#build',
    projectDir: path.join(root, 'app'),
    command: 'build',
    outputs: { files: ['dist/**'], workspaceFiles: [] },
  })
  await mkdir(path.join(here.root, 'app', 'dist'), { recursive: true })
  await writeFile(path.join(here.root, 'app', 'dist', 'out.js'), 'built')
  await here.artifacts.save(KEY, task(here.root), {
    output: [{ text: 'ok\n', err: false }],
    durationMs: 12,
  })
  expect(await here.artifacts.share(KEY)).toBe(true)
  expect(remote.puts()).toBe(1)
  remote.store.delete(KEY)
  const later = taskArtifacts(layeredOver(caches.at(-1)!, remote.layer), here.root)
  expect(await later.share(KEY)).toBe(true)
  expect(remote.puts()).toBe(2)
  expect(await later.share('fedcba9876543210')).toBe(false)

  const worker = await machine('worker', remote.layer)
  expect(await worker.artifacts.restore(KEY, task(worker.root))).toEqual([
    { text: 'ok\n', err: false },
  ])
})

// A remote copy that does not read back failed the dependant on every
// worker, and every run after: the remote said it held the key, so
// nothing sent this machine's good copy over it.
it('share sends the entry over a remote copy another machine found corrupt', async () => {
  const remote = memoryRemote()
  const here = await machine('here', remote.layer)
  const task = (root: string) => ({
    id: 'app#build',
    projectDir: path.join(root, 'app'),
    command: 'build',
    outputs: { files: ['dist/**'], workspaceFiles: [] },
  })
  await mkdir(path.join(here.root, 'app', 'dist'), { recursive: true })
  await writeFile(path.join(here.root, 'app', 'dist', 'out.js'), 'built')
  await here.artifacts.save(KEY, task(here.root), {
    output: [{ text: 'ok\n', err: false }],
    durationMs: 12,
  })
  expect(await here.artifacts.share(KEY)).toBe(true)
  remote.store.set(KEY, remote.store.get(KEY)!.slice(0, 40))
  const worker = await machine('worker', remote.layer)
  expect(await worker.artifacts.restore(KEY, task(worker.root))).toBeNull()
  expect(await here.artifacts.resend(KEY)).toBe(true)
  const again = await machine('worker2', remote.layer)
  expect(await again.artifacts.restore(KEY, task(again.root))).toEqual([
    { text: 'ok\n', err: false },
  ])
})

it('share uploads nothing to a remote the run does not write', async () => {
  const remote = memoryRemote()
  const root = path.join(dir, 'ro')
  await mkdir(path.join(root, 'app'), { recursive: true })
  const local = new Cache(path.join(root, '.vx', 'cache'), { read: true, write: true }, root)
  caches.push(local)
  const ro = taskArtifacts(
    layeredOver(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: false },
    }),
    root,
  )
  await ro.save(
    KEY,
    {
      id: 'app#t',
      projectDir: path.join(root, 'app'),
      command: 't',
      outputs: { files: [], workspaceFiles: [] },
    },
    { output: [], durationMs: 1 },
  )
  expect(await ro.share(KEY)).toBe(false)
  expect(remote.puts()).toBe(0)
})
