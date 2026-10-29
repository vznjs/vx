import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import {
  changedTracked,
  crowdShare,
  loadMeter,
  localEnv,
  runWorker,
  swapRoots,
  trackedFiles,
  treeMeter,
} from '../src/worker.js'
import { docker, dte, local } from '../src/index.js'
import { errorLine } from '../src/local.js'
import { bytes, changedSinceParent, homeOf, needOf, pace } from '../src/plugin.js'
import { hostPlatform, isUserError, type Platform, UserError } from '@vzn/vx'
import {
  type CacheFacts,
  type CapturedChunk,
  type ExecuteRequest,
  type TaskArtifacts,
  type TaskNode,
  ui,
} from '@vzn/vx'
import { nestedIn, Orchestrator, runKey } from '../src/orchestrator.js'
import { assign, fits, type Need } from '../src/dispatch.js'
import { names, outputFiles } from '../src/outputs.js'
import { Usage } from '../src/usage.js'
import { plan, planTasks, tailsMs } from '../src/planner.js'
import { join, RelayError } from '../src/wire.js'
import { sealOrchestrator, secretProof } from '../src/seal.js'
import type { RunOrder, ToWorker, WiredResult } from '../src/messages.js'
import { snapshot } from '../src/tree.js'
import { servedRelay } from './served-relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-unit-'))
  dirs.push(d)
  return d
}

/** A tmp dir that is a git checkout, as a worker's root is: a save is
 *  withheld where git cannot diff the task's project. */
const checkout = async (): Promise<string> => {
  const d = await tmp()
  // Each step checked: a fixture git refused read as a save withheld.
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], {
      cwd: d,
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`git ${a[0]}: ${r.stderr.toString()}`)
  }
  // A tracked file, as a worker's checkout has: of an empty tree, CI's git
  // (2.56) took no snapshot, so every save was withheld; 2.43 took one.
  await writeFile(path.join(d, 'README'), '')
  git('init', '-q')
  git('add', 'README')
  git('commit', '-q', '-m', 'i')
  return d
}

it('a worker clears the files a task’s outputs match, links included, before it runs it', async () => {
  const from = await tmp()
  await mkdir(path.join(from, 'p/out/deep'), { recursive: true })
  await writeFile(path.join(from, 'p/out/deep/a.sh'), 'echo hi\n')
  await symlink('deep/a.sh', path.join(from, 'p/out/link'))
  await writeFile(path.join(from, 'p/out/skip.map'), '')
  expect(
    await outputFiles(from, 'p', { files: ['out/**', '!out/*.map'], workspaceFiles: [] }),
  ).toEqual(['p/out/deep/a.sh', 'p/out/link'])
})

it('a worker runs the orchestrator’s env with its own root, host names and PATH', () => {
  const saved = {
    HOME: process.env['HOME'],
    PATH: process.env['PATH'],
    XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
  }
  process.env['HOME'] = '/worker/home'
  process.env['XDG_DATA_HOME'] = '/worker/data'
  process.env['PATH'] = '/usr/bin'
  try {
    expect(
      localEnv(
        {
          // Sent only when the task's `env.define` sets it.
          TMPDIR: '/defined/tmp',
          PATH: '/orc/ws/node_modules/.bin:/orc/ws2/bin:/orc/ws:/opt/orc',
          VX_RUN_WORKSPACE: '/orc/ws',
          X: '1',
          // A path beside the root or holding it is not under it: a plain replace moved both.
          SIBLING: '/orc/ws2/cache',
          HOLDS: '/private/orc/ws/x',
        },
        '/orc/ws',
        '/worker/ws',
      ),
    ).toMatchObject({
      HOME: '/worker/home',
      XDG_DATA_HOME: '/worker/data',
      TMPDIR: '/defined/tmp',
      PATH: '/worker/ws/node_modules/.bin:/worker/ws:/usr/bin',
      VX_RUN_WORKSPACE: '/worker/ws',
      X: '1',
      SIBLING: '/orc/ws2/cache',
      HOLDS: '/private/orc/ws/x',
    })
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
})

// Core sets it to the workspace's manager on every local task; a worker
// gave the one its own process happened to have (`bun vx dte worker`: bun),
// or none in the Docker image, where `npm-run-all` then looked for npm.
it("a worker names the workspace's package manager in npm_execpath, as a local run does", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-dte-pm-')))
  const saved = process.env['npm_execpath']
  try {
    await writeFile(path.join(root, 'package.json'), '{"packageManager":"pnpm@9.0.0"}')
    await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true })
    await writeFile(path.join(root, 'node_modules/.bin/pnpm'), '#!/bin/sh\n')
    await chmod(path.join(root, 'node_modules/.bin/pnpm'), 0o755)
    process.env['npm_execpath'] = '/elsewhere/bun'
    expect(localEnv({ PATH: '/usr/bin' }, '/orc/ws', root)['npm_execpath']).toBe(
      path.join(root, 'node_modules/.bin/pnpm'),
    )
    // A task's own `define` still wins.
    expect(localEnv({ npm_execpath: '/mine' }, '/orc/ws', root)['npm_execpath']).toBe('/mine')
  } finally {
    if (saved === undefined) delete process.env['npm_execpath']
    else process.env['npm_execpath'] = saved
    await rm(root, { recursive: true, force: true })
  }
})

it('a worker swaps each root once, the first pair naming it winning', () => {
  expect(
    swapRoots({ a: '/ws/p/x', b: ['/ws', '/ws2/q', '/private/ws/r'], c: 'x:/ws/b' }, [
      ['/ws', '/worker/ws'],
      ['/ws2', '/ws'],
    ]),
  ).toEqual({
    a: '/worker/ws/p/x',
    b: ['/worker/ws', '/ws/q', '/private/ws/r'],
    c: 'x:/worker/ws/b',
  })
})

it('a worker with other tracked files than the run is refused', async () => {
  const served = servedRelay()
  const url = served.url
  try {
    const o = new Orchestrator({
      me: await join(url, R, 'orchestrator', null, undefined),
      root: '/ws',
      tree: 'aaa',
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
    })
    const worker = await join(
      url,
      R,
      'worker',
      { v: 1, cores: 1, memory: 1, tree: 'bbb' },
      undefined,
    )
    let got: unknown[] = []
    for (let i = 0; i < 20 && got.length === 0; i++) got = await worker.poll()
    expect(got).toEqual([
      {
        from: 'orchestrator',
        body: { type: 'refused', reason: 'checked out tree bbb, the run is on aaa' },
      },
    ])
    await o.close()
  } finally {
    await served.stop()
  }
})

// 2026-10-23: a fault is at least a warning. The orchestrator dropped
// every send the relay would not take; a refusal lost left the worker idle.
it('a send to a worker the relay would not take is said', async () => {
  const served = servedRelay()
  try {
    const me = await join(served.url, R, 'orchestrator', null, undefined)
    const said: string[] = []
    const o = new Orchestrator({
      me: {
        id: me.id,
        heartbeatMs: me.heartbeatMs,
        online: true,
        resumed: () => {},
        poll: (signal) => me.poll(signal),
        remove: (id) => me.remove(id),
        leave: () => me.leave(),
        send: () => Promise.reject(new RelayError(503, 'relay: 503 overloaded')),
      },
      root: '/ws',
      tree: 'aaa',
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
      warn: (m) => said.push(m),
    })
    const worker = await join(
      served.url,
      R,
      'worker',
      { v: 1, cores: 1, memory: 1, tree: 'bbb' },
      undefined,
    )
    for (let i = 0; i < 40 && said.length === 0; i++) await Bun.sleep(50)
    expect(said).toEqual([
      `[vx] dte: sending refused to ${worker.id} failed: relay: 503 overloaded`,
    ])
    await o.close()
  } finally {
    await served.stop()
  }
})

// CI starts workers beside the orchestrator; on a warm run it can finish
// before a slow runner's worker joins, and that worker's job is not a failure.
// The relay keeps nothing of a run that ended: a worker late for it joins
// an empty run, which closes when no orchestrator joins (120 heartbeats).
it('a worker late for a run that ended exits 0', async () => {
  const served = servedRelay({ heartbeatMs: 20 })
  const url = served.url
  try {
    await (await join(url, R, 'orchestrator', null, undefined)).leave()
    const code = await runWorker({
      relay: url,
      run: R,
      root: process.cwd(),
      token: async () => undefined,
      proof: { psk: async () => new Uint8Array(32), mismatch: 'no key' },
      artifacts: () => fakeArtifacts().artifacts,
    })
    expect(code).toBe(0)
  } finally {
    await served.stop()
  }
})

// A relay restart its orchestrator does not join again within two
// heartbeats loses the worker. The run gave its tasks to others; the
// worker's CI job is no failure (mac#1 on #3895).
it('a worker the relay lost exits 0', async () => {
  const served = servedRelay({ heartbeatMs: 500 })
  const url = served.url
  try {
    const o = await join(url, R, 'orchestrator', null, undefined)
    const code = runWorker({
      relay: url,
      run: R,
      root: process.cwd(),
      token: async () => undefined,
      proof: { psk: async () => new Uint8Array(32), mismatch: 'no key' },
      artifacts: () => fakeArtifacts().artifacts,
    })
    for (let i = 0; i < 50 && (await o.poll()).length === 0; i++);
    served.refuse = (r) => decodeURIComponent(r.url).includes('"role":"host"')
    served.restart()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// The relay restarts, storing nothing, while a worker runs a task, and the
// orchestrator is back only a heartbeat later: the task's end still
// arrives, and the run never noticed (2026-10-25: "offline
// orchestrator or relay does not matter to the system").
it('a task a worker runs across a relay restart and its orchestrator’s absence ends as if neither happened', async () => {
  const root = await tmp()
  const served = servedRelay({ heartbeatMs: 500 })
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => fakeArtifacts().artifacts,
    })
    const order: RunOrder = {
      task: 't',
      key: 'k-t',
      runKey: runKey(R, 't'),
      deps: [],
      nested: [],
      command: 'sleep 1.5',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    const seen: string[] = []
    for (let i = 0; i < 100 && !seen.includes('end'); i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from === 'relay') {
          seen.push(m.type)
          if (m.type !== 'joined') continue
          await o.send(m.id!, { type: 'welcome', name: 'a', cache: { refs: [], lent: {} } })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
          continue
        }
        seen.push(m.type)
        if (m.type === 'start') {
          served.refuse = (r) => decodeURIComponent(r.url).includes('"role":"host"')
          served.restart()
          setTimeout(() => (served.refuse = undefined), 500)
        }
        if (m.type === 'end') await o.send(from, { type: 'exit' })
      }
    expect(seen.filter((t) => t !== 'held')).toEqual(['joined', 'start', 'ran', 'end'])
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// An orchestrator may send a task again to the worker running it (its lease
// ended while the relay was away): it is not run twice.
it('a worker sent a task it runs already does not run it again', async () => {
  const root = await tmp()
  const served = servedRelay({ heartbeatMs: 500 })
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => fakeArtifacts().artifacts,
    })
    const order: RunOrder = {
      task: 't',
      key: 'k-t',
      runKey: runKey(R, 't'),
      deps: [],
      nested: [],
      command: 'echo ran >> runs.txt && sleep 1',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    const seen: string[] = []
    for (let i = 0; i < 100 && !seen.includes('end'); i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        seen.push(m.type)
        if (from === 'relay') {
          if (m.type !== 'joined') continue
          await o.send(m.id!, { type: 'welcome', name: 'a', cache: { refs: [], lent: {} } })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
          continue
        }
        if (m.type === 'start')
          await o.send(from, { type: 'batch', root, realRoot: root, tasks: [order] })
        if (m.type === 'end') await o.send(from, { type: 'exit' })
      }
    expect(await code).toBe(0)
    expect(await readFile(path.join(root, 'runs.txt'), 'utf8')).toBe('ran\n')
    expect(seen.filter((t) => t === 'start')).toHaveLength(1)
  } finally {
    await served.stop()
  }
})

// A task runs in a process group of its own: a Ctrl-C reaches the worker
// (local() starts it in the terminal's group) but not the task, and a
// worker that died of it left the task running.
it('a worker stopped by a signal stops its tasks before it exits', async () => {
  const root = await tmp()
  const served = servedRelay()
  let pid: number | undefined
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'worker-child.ts'), served.url, R, root],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    const order: RunOrder = {
      task: 't',
      key: 'k-t',
      runKey: runKey(R, 't'),
      deps: [],
      nested: [],
      command: 'echo $$ > pid.txt && exec sleep 30',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    for (let i = 0; i < 100 && pid === undefined; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from !== 'relay' || m.type !== 'joined') continue
        await o.send(m.id!, { type: 'welcome', name: 'a', cache: { refs: [], lent: {} } })
        await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
      }
      const text = await readFile(path.join(root, 'pid.txt'), 'utf8').catch(() => '')
      if (text.endsWith('\n')) pid = Number(text)
    }
    expect(pid).toBeNumber()
    child.kill('SIGINT')
    expect(await child.exited).toBe(130)
    const alive = (): boolean => {
      try {
        process.kill(pid!, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(false)
    pid = undefined
    // Not the task's failure: it runs again on another worker.
    const after = (await o.poll()).map(({ body }) => (body as { type: string }).type)
    expect(after).not.toContain('end')
  } finally {
    if (pid !== undefined) process.kill(pid, 'SIGKILL')
    await served.stop()
  }
})

it('gives failed worker starts three more workers, then fails the run', async () => {
  const served = servedRelay()
  const url = served.url
  try {
    const freed: string[] = []
    const o = new Orchestrator({
      me: await join(url, R, 'orchestrator', null, undefined),
      root: '/ws',
      tree: 'aaa',
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
      lost: (id) => {
        freed.push(id)
        // As dte() does: the freed place starts the next worker.
        o.spawned(`small#${freed.length + 1}`, { size: 'small', cpu: 1, memory: 1 })
      },
    })
    o.spawned('small#1', { size: 'small', cpu: 1, memory: 1 })
    for (let i = 1; i <= 4; i++) o.failed(`small#${i}`, 'install exited 1: ECONNRESET')
    const run = o.execute({ taskId: 'p#t' } as Parameters<typeof o.execute>[0])
    expect([freed, await run.catch((e: Error) => e.message)]).toEqual([
      ['small#1', 'small#2', 'small#3'],
      'no worker could start: small#4 install exited 1: ECONNRESET',
    ])
    await o.close()
  } finally {
    await served.stop()
  }
})

// small#4's join timed out on the relay and its job's end never reached
// the run: it counted as starting for good, and main's run sat 18 min
// (ee3fc6e, 2026-10-23). With no join deadline (2026-10-23: "no
// timeouts at all"), a job that ends, a success too, is what says so.
it('starts another for a worker whose job ended before it joined, a success too', async () => {
  const served = servedRelay()
  try {
    const freed: string[] = []
    const o = new Orchestrator({
      me: await join(served.url, R, 'orchestrator', null, undefined),
      root: '/ws',
      tree: 'aaa',
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
      lost: (id) => freed.push(id),
    })
    o.spawned('small#1', { size: 'small', cpu: 1, memory: 1 })
    await Bun.sleep(50)
    expect(freed).toEqual([])
    o.failed('small#1', 'job success')
    expect(freed).toEqual(['small#1'])
    await o.close()
  } finally {
    await served.stop()
  }
})

// Owner, 2026-10-23: "we learn that from fist we get, and double its time
// as max wait time for other". Before, a fixed 3 min.
it('gives up a started worker past twice the first of its size’s join, and stops it', async () => {
  const overdue: string[] = []
  const h = await harness(new Map([node('t1')]), undefined, 60_000, undefined, undefined, {
    overdue: (id) => overdue.push(id),
  })
  try {
    h.o.spawned('worker#1', { size: 'small', cpu: 1, memory: 1 })
    h.o.spawned('worker#2', { size: 'small', cpu: 1, memory: 1 })
    h.o.spawned('mac#1', { size: 'mac', cpu: 1, memory: 1 })
    await Bun.sleep(100)
    expect(overdue).toEqual([])
    await h.worker(1, 'worker#1')
    await Bun.sleep(400)
    expect(overdue).toEqual(['worker#2'])
  } finally {
    await h.stop()
  }
})

// Main db1702f (2026-10-24): three smalls GitHub queued 60 s were given up
// at their join limit and others asked; the three joined later, were told
// to exit, and the run ended at 232 s against an ideal of 141 s. A worker
// given up for lateness that joins after all is taken.
it('takes a worker given up past its join limit that joins after all', async () => {
  const overdue: string[] = []
  const h = await harness(new Map([node('t1')]), undefined, 60_000, undefined, undefined, {
    overdue: (id) => overdue.push(id),
  })
  try {
    h.o.spawned('worker#1', { size: 'small', cpu: 1, memory: 1 })
    h.o.spawned('worker#2', { size: 'small', cpu: 1, memory: 1 })
    await h.worker(1, 'worker#1')
    for (let i = 0; i < 50 && overdue.length === 0; i++) await Bun.sleep(20)
    expect(overdue).toEqual(['worker#2'])
    const late = await h.worker(1, 'worker#2')
    const first = (await late.poll()).map((m) => m.body as { type: string; name?: string })
    expect(first[0]).toMatchObject({ type: 'welcome', name: 'worker#2' })
  } finally {
    await h.stop()
  }
})

// PR 2f0e2a4 (2026-10-24): GitHub queued smalls 30-85 s; the run asked
// more behind them and replaced those its join limit gave up on. A size
// with a worker late to join, or given up as late beside one online, is
// queued: the plan starts none of it.
it('a size is queued while a worker of it is late, given up beside one online', async () => {
  const overdue: string[] = []
  const h = await harness(new Map([node('t1')]), undefined, 60_000, undefined, undefined, {
    overdue: (id) => overdue.push(id),
  })
  try {
    h.o.spawned('worker#1', { size: 'small', cpu: 1, memory: 1 })
    h.o.spawned('worker#2', { size: 'small', cpu: 1, memory: 1 })
    expect(h.o.queued(() => 60_000)).toEqual(new Set())
    expect(h.o.queued(() => 0)).toEqual(new Set(['small']))
    await h.worker(1, 'worker#1')
    for (let i = 0; i < 50 && overdue.length === 0; i++) await Bun.sleep(20)
    expect(overdue).toEqual(['worker#2'])
    expect(h.o.queued(() => 60_000)).toEqual(new Set(['small']))
    // Its job ended: it joins no more.
    h.o.failed('worker#2', 'job cancelled')
    expect(h.o.queued(() => 60_000)).toEqual(new Set())
  } finally {
    await h.stop()
  }
})

/** A cache by key, in memory: what workers saved, and each restore asked. */
function fakeArtifacts() {
  const saved = new Map<string, CapturedChunk[]>()
  const restored: string[] = []
  const shared: string[] = []
  const artifacts: TaskArtifacts = {
    async save() {},
    async restore(key) {
      restored.push(key)
      return saved.get(key) ?? null
    },
    async output(key) {
      return saved.get(key) ?? null
    },
    async share(key) {
      shared.push(key)
      return true
    },
    async resend(key) {
      shared.push(`${key} again`)
      return true
    },
  }
  return { artifacts, saved, restored, shared }
}

/** An orchestrator on a loopback relay, and workers of it that only listen. */
async function harness(
  nodes: Map<string, TaskNode>,
  need: (id: string) => Need = () => ({ cores: 1, memory: 10 }),
  heartbeatMs?: number,
  keyOf: (id: string) => string | undefined = () => undefined,
  tail?: (id: string) => number,
  more: {
    faulted?: () => void
    home?: string
    stalled?: (waiting: string) => void
    stallMs?: number
    overdue?: (id: string) => void
    sent?: Map<string, number>
    pinWaitMs?: number
  } = {},
) {
  const store = fakeArtifacts()
  const cache: { facts: CacheFacts } = { facts: { refs: [], lent: {} } }
  const served = servedRelay(heartbeatMs === undefined ? {} : { heartbeatMs })
  const url = served.url
  const o = new Orchestrator({
    me: await join(url, R, 'orchestrator', null, undefined),
    root: '/ws',
    tree: 'c',
    nodes: () => nodes,
    need,
    artifacts: store.artifacts,
    cacheFacts: async () => cache.facts,
    run: R,
    keyOf,
    ...(tail === undefined ? {} : { tail }),
    ...more,
  })
  const worker = async (cores: number, id?: string, platform?: string) => {
    const me = await join(
      url,
      R,
      'worker',
      { v: 1, cores, memory: 100, tree: 'c', id, ...(platform === undefined ? {} : { platform }) },
      undefined,
    )
    const orders: RunOrder[] = []
    const batches = async (): Promise<string[][]> => {
      for (let i = 0; i < 20; i++) {
        const got = (await me.poll()).map((m) => m.body as { type: string; tasks?: RunOrder[] })
        const b = got.filter((m) => m.type === 'batch').map((m) => m.tasks!)
        orders.push(...b.flat())
        if (b.length > 0) return b.map((t) => t.map((o) => o.task))
      }
      return []
    }
    const finish = async (
      task: string,
      key = `k-${task}`,
      result: object = { exitCode: 0, durationMs: 1 },
    ): Promise<void> => {
      store.saved.set(key, [{ text: `${task} out\n`, err: false }])
      await me.send('orchestrator', { type: 'end', task, key, result })
    }
    const begin = (task: string) => me.send('orchestrator', { type: 'start', task })
    const say = (body: object) => me.send('orchestrator', body)
    const types = async (): Promise<string[]> => {
      const seen: string[] = []
      for (let i = 0; i < 5 && !seen.includes('exit'); i++)
        seen.push(...(await me.poll()).map((m) => (m.body as { type: string }).type))
      return seen
    }
    /** The next messages that are not batches, by type. */
    const bodies = async (): Promise<{ type: string; task?: string }[]> => {
      for (let i = 0; i < 20; i++) {
        const got = (await me.poll()).map((m) => m.body as { type: string; tasks?: RunOrder[] })
        orders.push(...got.flatMap((m) => (m.type === 'batch' ? m.tasks! : [])))
        const rest = got.filter((m) => !['batch', 'welcome', 'cache'].includes(m.type))
        if (rest.length > 0) return rest
      }
      return []
    }
    return {
      batches,
      bodies,
      finish,
      begin,
      say,
      types,
      orders,
      poll: () => me.poll(),
      leave: () => me.leave(),
      id: me.id,
    }
  }
  const req = (taskId: string, cacheKey?: string) =>
    ({
      taskId,
      ...(cacheKey === undefined ? {} : { cacheKey }),
      workspaceRoot: '/ws',
      command: 'true',
      forwardArgs: [],
      cwd: '/ws',
      env: {},
      envDefine: {},
      outputs: { files: [], workspaceFiles: [] },
      onStdout() {},
      onStderr() {},
    }) as unknown as ExecuteRequest
  const stop = async () => {
    await o.close()
    await served.stop()
  }
  return { o, worker, req, stop, store, cache, served }
}

it('a worker reads the cache as the run does, and is lent its remotes’ access again before it ends', async () => {
  const h = await harness(new Map())
  try {
    h.cache.facts = {
      refs: ['refs/heads/feat', 'refs/heads/main'],
      lent: { '@vzn/vx-migrate': 't1' },
      expiresAt: Date.now() + 4 * 60_000 + 300,
    }
    const a = await h.worker(2)
    const got: unknown[] = []
    for (let i = 0; i < 20 && got.length < 2; i++) {
      got.push(...(await a.poll()).map((m) => m.body))
      if (got.length === 1)
        h.cache.facts = { refs: ['refs/heads/feat'], lent: { '@vzn/vx-migrate': 't2' } }
    }
    expect(got).toEqual([
      {
        type: 'welcome',
        name: 'worker#1',
        cache: {
          refs: ['refs/heads/feat', 'refs/heads/main'],
          lent: { '@vzn/vx-migrate': 't1' },
          expiresAt: expect.any(Number),
        },
      },
      { type: 'cache', cache: { refs: ['refs/heads/feat'], lent: { '@vzn/vx-migrate': 't2' } } },
    ])
  } finally {
    await h.stop()
  }
})

// Core's lend lends nothing for a remote whose lend threw (a CI OIDC 5xx):
// the run sent that to its workers, which lost the remote while its token
// still held, and, as that token ended no relend came, for the rest of the run.
it('a relend that lends a remote nothing keeps the token it lent before', async () => {
  const h = await harness(new Map())
  try {
    h.cache.facts = {
      refs: ['refs/heads/main'],
      lent: { '@vzn/vx-cache': 't1' },
      expiresAt: Date.now() + 4 * 60_000 + 200,
    }
    const a = await h.worker(2)
    const got: { type: string; cache?: { lent: Record<string, string> } }[] = []
    const until = Date.now() + 1200
    while (Date.now() < until) {
      got.push(
        ...(await Promise.race([a.poll(), Bun.sleep(until - Date.now()).then(() => [])])).map(
          (m) => m.body as (typeof got)[number],
        ),
      )
      if (got.length === 1) h.cache.facts = { refs: ['refs/heads/main'], lent: {} }
    }
    expect(got[0]?.type).toBe('welcome')
    for (const m of got) expect(m.cache?.lent).toEqual({ '@vzn/vx-cache': 't1' })
  } finally {
    await h.stop()
  }
})

it('a lent token already ended is not lent again at once, in a loop', async () => {
  const h = await harness(new Map())
  try {
    let asked = 0
    // Each ask lends a token that ends as it is lent.
    Object.defineProperty(h.cache, 'facts', {
      get: () => (
        asked++,
        { refs: ['refs/heads/main'], lent: { '@vzn/vx-cache': 't' }, expiresAt: Date.now() }
      ),
    })
    const a = await h.worker(2)
    await a.poll()
    await Bun.sleep(200)
    // Unfloored: 176 asks in 200 ms, each sent to every worker.
    expect(asked).toBe(1)
  } finally {
    await h.stop()
  }
})

const node = (id: string, deps: string[] = []) =>
  [id, { id, deps, projectDir: '/ws', config: {} } as unknown as TaskNode] as const

// Each pump walked every queued task's upstreams and asked every worker of
// each: 2000 queued down one chain spent 4 million walks a pump (2026-10-25).
it('pumps a long queue in time that does not grow with its upstreams', async () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `t${i}`)
  const h = await harness(new Map(ids.map((id, i) => node(id, i === 0 ? [] : [`t${i - 1}`]))))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    for (const id of ids) void h.o.execute(h.req(id))
    expect((await a.batches()).flat()).toHaveLength(1)
    const pump = (): void => (h.o as unknown as { pump(): void }).pump()
    pump()
    const start = process.cpuUsage()
    for (let i = 0; i < 20; i++) pump()
    const { user, system } = process.cpuUsage(start)
    expect((user + system) / 1000).toBeLessThan(1000)
  } finally {
    await h.stop()
  }
})

// 2026-10-23: "we should not send tasks in batches unless we are 100%
// sure ... they can fit". Main bf77a58: small#3's load read low while 38
// test shards began, so it took them all on 4 cores, 28 failed, and the 5
// workers started for them got none. Load only ever adds to the booking.
it('sends a worker what its booking fits, though its load reads low; busier than booked, less', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `t${i + 1}`)
  const h = await harness(new Map(ids.map((id) => node(id))))
  try {
    const a = await h.worker(4)
    await Bun.sleep(50)
    for (const id of ids) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2', 't3', 't4']])
    for (const id of ['t1', 't2', 't3', 't4'])
      await a.say({ type: 'start', task: id, load: { cpu: 0.1, memory: 0 } })
    await Bun.sleep(50)
    expect(h.o.where('t5')).toBeNull()
    // The worker started for them gets them.
    const b = await h.worker(4)
    expect(await b.batches()).toEqual([['t5', 't6', 't7', 't8']])
    // Its machine busier than booked: the core a task freed stays taken.
    await b.say({ type: 'start', task: 't5', load: { cpu: 4, memory: 0 } })
    await b.finish('t5')
    await b.say({ type: 'held', running: ['t6', 't7', 't8'], load: { cpu: 4, memory: 0 } })
    const t9 = h.o.execute(h.req('t9'))
    await Bun.sleep(50)
    expect(h.o.where('t9')).toBeNull()
    // The plan holds its tasks at what its load says, not their history.
    const held = h.o
      .planState(() => undefined, 0)
      .workers.find((w) => w.id === b.id)!
      .running.reduce((n, r) => n + r.cores, 0)
    expect(held).toBeCloseTo(4)
    void t9
  } finally {
    await h.stop()
  }
})

// Main 2975e38: a Mac's frame as a task ended read 2.9 of 3 cores busy,
// that task and its save among them, and held the next task for the next
// frame, up to 30 s on.
it('places on a worker by its booking once a task ends: the load it reported counted that task', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    void h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t1', 't2']])
    for (const id of ['t1', 't2'])
      await a.say({ type: 'start', task: id, load: { cpu: 2, memory: 0 } })
    void h.o.execute(h.req('t3'))
    await Bun.sleep(50)
    expect(h.o.where('t3')).toBeNull()
    await a.say({ type: 'ran', task: 't1', load: { cpu: 2, memory: 0 } })
    expect(await a.batches()).toEqual([['t3']])
  } finally {
    await h.stop()
  }
})

// Cold main bcc84f1: an unmeasured task counted 2 cores waiting and the
// one it holds running, so each start freed room the plan found spare and
// it cancelled 11 of the 25 workers it asked.
it('plans a running unmeasured task as it planned it waiting', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]), () => ({
    cores: 1,
    memory: 0,
    ask: { cores: 2, memory: 4e9 },
  }))
  try {
    const a = await h.worker(4)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    void h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t1', 't2']])
    for (const id of ['t1', 't2'])
      await a.say({ type: 'start', task: id, load: { cpu: 0.1, memory: 0 } })
    await Bun.sleep(50)
    const running = h.o.planState(() => undefined, 0).workers.find((w) => w.id === a.id)!.running
    expect(running.map((r) => r.cores)).toEqual([2, 2])
  } finally {
    await h.stop()
  }
})

// Cold run 3, 2026-10-23: tasks booked at their history used 82% of it,
// and every Linux worker ran at 63-73% CPU against the sim's 86%.
it('books measured tasks at the share of their history the run’s tasks used, at most half again more', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`)
  const h = await harness(new Map(ids.map((id) => node(id))))
  try {
    const a = await h.worker(4)
    await Bun.sleep(50)
    for (const id of ids.slice(0, 4)) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2', 't3', 't4']])
    for (const id of ['t1', 't2', 't3', 't4']) {
      await a.begin(id)
      h.store.saved.set(`k-${id}`, [])
      // Half a core of the one its history booked.
      await a.say({
        type: 'end',
        task: id,
        key: `k-${id}`,
        result: { exitCode: 0, durationMs: 20_000, cpuMs: 10_000 },
      })
    }
    await Bun.sleep(50)
    for (const id of ids.slice(4)) void h.o.execute(h.req(id))
    // Half each would fit 8; bookings stop at 1.5 times its cores.
    expect((await a.batches()).flat()).toEqual(['t5', 't6', 't7', 't8', 't9', 't10'])
    await h.stop()
    const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
    expect(rows.find((r) => r.includes('total'))).toContain('tasks used 50% of their history')
  } finally {
    await h.stop()
  }
})

// Main, 2026-10-23: 12 workers of 4 cores each ran about one task, at 25%
// CPU all their time online; packed, the ones the rest does not need leave.
it('packs tasks onto the worker with fewest cores free, and the idle one leaves', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    const a = await h.worker(4)
    const b = await h.worker(4)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2', 't3']])
    // Only an idle one goes.
    h.o.release([a.id, b.id])
    expect(await b.bodies()).toEqual([{ type: 'exit' }])
    expect(h.o.planState(() => undefined, 0).workers.map((w) => w.id)).toEqual([a.id])
  } finally {
    await h.stop()
  }
})

// Main, 2026-10-23: workers read booked 4.2 of 4 cores, each task held
// until its outputs saved: booked is from its start to its command's end.
it('books a worker the cores of a task from its start to its command’s end', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  const a = await h.worker(2)
  await Bun.sleep(50)
  for (const id of ['t1', 't2']) void h.o.execute(h.req(id))
  expect(await a.batches()).toEqual([['t1', 't2']])
  await a.begin('t1')
  await a.say({ type: 'ran', task: 't1' })
  await Bun.sleep(300)
  await h.stop()
  const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
  // A bound, not 0.0: the relay's time between begin and ran is booked,
  // and a slow CI runner read 0.1 (2026-10-24). Held to its save, t1 is
  // booked over the sleep, past half.
  const booked = Number(/booked avg ([\d.]+)/.exec(rows.join('\n'))?.[1])
  expect(booked).toBeLessThan(0.3)
})

it('says each worker’s machine busy average from the loads it sent', async () => {
  const h = await harness(new Map([node('t1')]))
  const a = await h.worker(4)
  await Bun.sleep(50)
  void h.o.execute(h.req('t1'))
  expect(await a.batches()).toEqual([['t1']])
  // Its last frame's average, not the run's of its samples: a worker that
  // sent 3 frames, each as a task started, read 0.6 of 2.0 used (#4313).
  await a.say({ type: 'start', task: 't1', load: { cpu: 0.2, memory: 0, avg: 1 } })
  await a.say({ type: 'ran', task: 't1', load: { cpu: 0.2, memory: 0, avg: 3 } })
  await Bun.sleep(50)
  await h.stop()
  const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
  expect(rows.find((r) => r.includes('used avg'))).toContain('· machine avg 3.0 ·')
})

it('says no worker started once a run that needed none is over', async () => {
  const h = await harness(new Map([node('t1')]))
  expect(h.o.footer()).toEqual([])
  await h.stop()
  expect(h.o.footer().map(([k, line]) => [k, ui.inline(line, { enabled: false })])).toEqual([
    ['workers', 'none started: no task needed one'],
  ])
})

it('says a worker that never joined did not, once the run is over', async () => {
  const h = await harness(new Map([node('t1')]))
  h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 1 })
  const row = () =>
    h.o
      .footer()
      .map(([, line]) => ui.inline(line, { enabled: false }))
      .find((r) => r.includes('small#1'))
  expect(row()).toContain('starting')
  await h.stop()
  expect(row()).toContain('not joined  the run ended first')
})

// 2026-10-23: "a generated Chrome profile with all workers and tasks
// they executed in time so you could debug better".
it('profiles the run: each worker’s tasks on their own lanes, the run’s waits and restores', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  const a = await h.worker(2)
  await Bun.sleep(50)
  const done = ['t1', 't2'].map((id) => h.o.execute(h.req(id)))
  expect(await a.batches()).toEqual([['t1', 't2']])
  for (const t of ['t1', 't2']) await a.begin(t)
  await a.say({ type: 'held', running: ['t1', 't2'], load: { cpu: 1.5, memory: 0, tasks: 1.2 } })
  // PR #4214's run asked 7 workers and cancelled each a second later: what each plan saw.
  h.o.planned({
    start: ['small'],
    release: [],
    tasks: 3,
    endsInMs: 60_000,
    boundMs: 63_000,
    workers: [
      { ...h.o.planState(() => 5_000, 0).workers[0]!, id: 'worker#1' },
      {
        id: 'small#2',
        cores: 4,
        memory: 1e9,
        at: 12_000,
        running: [],
        idle: false,
        starting: true,
      },
    ],
    // Main d8a795c planned 38 s for an 88 s Mac lane: what it thought each took.
    work: [
      { id: 'p#build', cores: 2.16, memory: 0, ms: 33_240, deps: [], platform: 'darwin' },
      { id: 'p#new', cores: 1, memory: 0, ms: undefined, deps: [] },
    ],
    warmUps: new Map([['mac', 16_900]]),
  })
  await Bun.sleep(20)
  await a.say({ type: 'ran', task: 't1' })
  await Bun.sleep(20)
  for (const t of ['t1', 't2']) await a.finish(t)
  await Promise.all(done)
  await h.stop()
  const ev = h.o.profile() as unknown as {
    ph: string
    name: string
    cat?: string
    pid: number
    tid: number
    args?: { name?: string }
  }[]
  const pidOf = (name: string) =>
    ev.find((e) => e.ph === 'M' && e.name === 'process_name' && e.args?.name === name)?.pid
  const w = pidOf('worker#1')
  expect(pidOf('orchestrator')).toBe(1)
  expect(w).toBe(2)
  // Both at once on the worker: one row each.
  const tasks = ev.filter(
    (e) => e.ph === 'X' && e.cat === 'task' && e.pid === w && e.name.startsWith('t'),
  )
  expect(Object.fromEntries(tasks.map((e) => [e.name, e.tid]))).toEqual({ t1: 1, t2: 2 })
  for (const part of ['sent', 'restore deps', 'command', 'save'])
    expect(ev.some((e) => e.ph === 'X' && e.pid === w && e.name === part)).toBe(true)
  const run = ev.filter((e) => e.ph === 'X' && e.pid === 1)
  expect(
    run
      .filter((e) => e.cat === 'queue')
      .map((e) => e.name)
      .sort(),
  ).toEqual(['t1', 't2'])
  expect(
    run
      .filter((e) => e.cat === 'restore')
      .map((e) => e.name)
      .sort(),
  ).toEqual(['t1', 't2'])
  expect(ev.some((e) => e.ph === 'i' && e.pid === w && e.name === 'stopped')).toBe(true)
  expect(ev.some((e) => e.ph === 'C' && e.pid === w && e.name === 'cores')).toBe(true)
  // What its machine had busy, its tasks' or not: what a full Mac queued on.
  expect(
    ev
      .filter((e) => e.ph === 'C' && e.pid === w && e.name === 'machine')
      .map((e) => e.args as unknown),
  ).toContainEqual({ busy: 1.5, tasks: 1.2 })
  const plan = ev.find((e) => e.ph === 'i' && e.pid === 1 && e.name === 'plan') as
    | { args: Record<string, unknown> }
    | undefined
  expect(plan?.args).toMatchObject({ start: 'small', tasks: 3, endsInMs: 60_000, boundMs: 63_000 })
  expect(plan?.args.workers).toMatch(/^worker#1 1c\/\d+ 1c\/\d+ · small#2 joins 12000$/)
  expect(plan?.args).toMatchObject({
    work: 'p#build 33.2s 2.16c darwin · p#new ?s 1c',
    warmUps: 'mac 16.9s',
  })
})

// Main, 2026-10-23: vx-docs#build (41 s, then its test) got ready 3 s in,
// behind 46 shards ready at once, and began 47 s in: the run's end.
it('places the queued task the most of the run waits on first, not the first asked', async () => {
  const ids = ['t1', 's1', 's2', 's3', 'build']
  const tail = (id: string) => (id === 'build' ? 45_000 : 35_000)
  const h = await harness(new Map(ids.map((id) => node(id))), undefined, undefined, undefined, tail)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    for (const id of ids) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['build']])
    await a.finish('build')
    expect(await a.batches()).toEqual([['t1']])
  } finally {
    await h.stop()
  }
})

it('a task’s tail is its duration and its longest chain of dependants', () => {
  const runs = (id: string, deps: string[] = []) =>
    [
      id,
      { id, deps, projectDir: '/ws', config: { exec: { command: 'x' } } } as unknown as TaskNode,
    ] as const
  const nodes = new Map([
    runs('import'),
    runs('build', ['import']),
    runs('test', ['build']),
    runs('shard'),
    [
      'ci',
      { id: 'ci', deps: ['test', 'shard'], projectDir: '/ws', config: {} } as unknown as TaskNode,
    ] as const,
  ])
  const ms: Record<string, number> = { import: 1_000, build: 41_000, test: 4_000 }
  const tail = tailsMs(nodes, (id) => ms[id])
  expect(['import', 'build', 'test', 'shard', 'ci'].map(tail)).toEqual([
    46_000, 45_000, 4_000, 30_000, 0,
  ])
})

// 2026-10-21: check.bun, ahead of 8 shards, sat in a busy worker's
// queue as its prefetch while workers that joined later stood idle. None
// waits in a worker's queue now: it waits here for the first that is free.
it('a task no worker fits waits here, and goes to the first one free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    for (const id of ['t1', 't2']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['t2']])
  } finally {
    await h.stop()
  }
})

// Main 871ffba, 2026-10-23: check.bun, unmeasured so alone on a worker,
// waited 50 s while tasks behind it filled that worker again and again.
it('a task that runs alone holds the worker it waits for; none after it takes it', async () => {
  const h = await harness(
    new Map([node('t1'), node('alone'), node('t3')]),
    (id) => (id === 'alone' ? { cores: Infinity, memory: Infinity } : { cores: 1, memory: 10 }),
    undefined,
    undefined,
    (id) => (id === 'alone' ? 100 : 1),
  )
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    for (const id of ['alone', 't3']) void h.o.execute(h.req(id))
    await Bun.sleep(50)
    await a.finish('t1')
    expect(await a.batches()).toEqual([['alone']])
  } finally {
    await h.stop()
  }
})

// 2026-10-23: "If workers joined and nothing is queued anymore orch
// should ... close them": one started and not needed is cancelled, and
// told to exit should it join anyway.
it('a worker cancelled before it joined is told to exit when it joins, and never counted', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    // Another size: small#1's join, a few ms here, would give it up first.
    h.o.spawned('small#2', { size: 'big', cpu: 1, memory: 100 })
    const a = await h.worker(1, 'small#1')
    await Bun.sleep(50)
    expect(h.o.release(['small#2'])).toEqual(['small#2'])
    expect(h.o.planState(() => undefined, 0).workers.map((w) => w.id)).toEqual([a.id])
    const b = await h.worker(1, 'small#2')
    expect(await b.types()).toEqual(['exit'])
    h.o.failed('small#2', 'job cancelled')
    expect(h.o.machines().map((m) => m.name)).toEqual(['small#1'])
  } finally {
    await h.stop()
  }
})

// exec.platforms (2026-10-23): a task core placed on a platform goes
// only to a worker of it, and a worker whose size says another is refused.
it('a task on a platform goes only to a worker of it', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(4, undefined, 'linux-x64')
    const b = await h.worker(4, undefined, 'darwin-arm64')
    await Bun.sleep(50)
    void h.o.execute({ ...h.req('t1'), platform: 'darwin-arm64' })
    expect(await b.batches()).toEqual([['t1']])
    expect(h.o.planState(() => undefined, 0).workers.find((w) => w.id === a.id)?.idle).toBe(true)
  } finally {
    await h.stop()
  }
})

it('a task naming no platform goes only to a worker of the run’s home platform', async () => {
  const h = await harness(new Map([node('t1')]), undefined, undefined, undefined, undefined, {
    home: 'linux-x64',
  })
  try {
    const mac = await h.worker(4, undefined, 'darwin-arm64')
    const linux = await h.worker(4, undefined, 'linux-x64')
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await linux.batches()).toEqual([['t1']])
    expect(h.o.planState(() => undefined, 0).workers.find((w) => w.id === mac.id)?.idle).toBe(true)
  } finally {
    await h.stop()
  }
})

// A size that names no platform is planned as this machine's (plugin.ts),
// but its workers still starting were planned on none: in a run over two
// platforms every task names one, so none fit them, and each plan
// cancelled the Linux workers the one before had asked.
it('plans a worker still starting, of a size naming no platform, as this machine’s', async () => {
  const h = await harness(new Map([node('t1')]), undefined, undefined, undefined, undefined, {
    home: hostPlatform(),
  })
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 4, memory: 1e9 })
    const { workers } = h.o.planState(() => undefined, 20_000)
    expect(workers.map((w) => w.platform)).toEqual([hostPlatform()])
    const t1 = { id: 't1', cores: 1, memory: 1, ms: 10_000, deps: [], platform: hostPlatform() }
    const small = { name: 'small', max: 2, cpu: 4, memory: 1e9, platform: hostPlatform() }
    const p = plan([t1], workers, [small], 20_000)
    expect([p.release, p.start]).toEqual([[], []])
  } finally {
    await h.stop()
  }
})

it('a run’s home platform is this machine’s only beside another it can start', () => {
  const size = (platform: Platform, max = 1) => ({
    name: platform,
    max,
    cpu: 1,
    memory: 1,
    platform,
  })
  expect(homeOf([size('linux-x64'), size('darwin-arm64')], 'linux-x64')).toBe('linux-x64')
  expect(homeOf([size('linux-x64')], 'linux-x64')).toBeUndefined()
  expect(homeOf([size('darwin-arm64'), size('linux-arm64')], 'linux-x64')).toBeUndefined()
  expect(homeOf([size('linux-x64', 0), size('darwin-arm64')], 'linux-x64')).toBeUndefined()
})

it('a worker whose machine is not its size’s platform is refused', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    h.o.spawned('mac#1', { size: 'mac', cpu: 4, memory: 100, platform: 'darwin-arm64' })
    const a = await h.worker(4, 'mac#1', 'linux-x64')
    const got: unknown[] = []
    for (let i = 0; i < 10 && got.length === 0; i++)
      got.push(
        ...(await a.poll())
          .map((m) => m.body)
          .filter((b) => (b as { type: string }).type === 'refused'),
      )
    expect(got).toEqual([
      { type: 'refused', reason: 'runs on linux-x64, and its size mac says darwin-arm64' },
    ])
  } finally {
    await h.stop()
  }
})

it('an idle worker that faulted is let go', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    const b = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    expect(await b.batches()).toEqual([['t1']])
    h.o.release([])
    expect(await a.bodies()).toEqual([{ type: 'exit' }])
  } finally {
    await h.stop()
  }
})

// Growth, 2026-10-21: four local() workers of 1 core on a 4-core host each
// reported the host and took 4 tasks plus a prefetch, 16 wide on 4 cores.
// Its load is its host's, so the run counts what it booked.
it('a worker of a declared size is sent work for that size, not its machine', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.worker(4, 'small#1')
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3']) void h.o.execute(h.req(id))
    // 1 core: one at a time.
    expect(await a.batches()).toEqual([['t1']])
  } finally {
    await h.stop()
  }
})

// 2026-10-21: 16 rows said running while 4 workers ran 4 of them; and
// a worker's cores and memory belong to the final summary only.
it('a task waits until a worker begins it; the live rows leave out its machine', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3'), node('t4')]))
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3', 't4']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2']])
    expect(['t1', 't2', 't3', 't4'].map((t) => h.o.where(t))).toEqual([null, null, null, null])
    expect(h.o.where('other')).toBeUndefined()
    await a.begin('t1')
    for (let i = 0; i < 40 && h.o.where('t1') === null; i++) await Bun.sleep(25)
    expect(['t1', 't2'].map((t) => h.o.where(t))).toEqual(['worker#1', null])
    const live = JSON.stringify(h.o.footer())
    expect(live).toContain('1 running')
    expect(live).not.toMatch(/\dc\//)
  } finally {
    await h.stop()
  }
})

// A worker the rest of the run cannot keep busy leaves rather than idle
// until the run ends; one a remaining task needs for its size stays.
it('a worker the plan lets go leaves, and the plan no longer places on it', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(4)
    const b = await h.worker(2)
    await Bun.sleep(50)
    h.o.release([b.id])
    expect(await b.types()).toContain('exit')
    const footer = JSON.stringify(h.o.footer())
    expect(footer).toContain('left')
    expect(h.o.planState(() => undefined, 0).workers.map((w) => w.cores)).toEqual([4])
    h.o.release([a.id])
    expect(await a.types()).toContain('exit')
    expect(h.o.planState(() => undefined, 0).workers).toEqual([])
  } finally {
    await h.stop()
  }
})

// Its job ending after it left (a success: adapters report every end now)
// counted it as a start that failed, and could start another.
it('a worker that left is not failed or replaced when its job then ends', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    h.o.release([a.id])
    expect(await a.types()).toContain('exit')
    h.o.failed('worker#1', 'job success')
    expect(h.o.machines().map((m) => [m.name, m.status])).toEqual([['worker#1', 'ok']])
  } finally {
    await h.stop()
  }
})

// 2026-10-23: "we need the ideal time possible taking into account actual run numbers".
it('replays what each task took on every worker the sizes allow: the ideal end', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const sizes = [{ name: 'small', max: 2, cpu: 4, memory: 1e10 }]
    expect(h.o.idealMs(() => [], sizes)).toBeUndefined()
    const w = await h.worker(4)
    await Bun.sleep(50)
    const runs = [h.o.execute(h.req('t1')), h.o.execute(h.req('t2'))]
    await w.batches()
    await Bun.sleep(200)
    const done = { exitCode: 0, durationMs: 200, cpuMs: 200 }
    await w.finish('t1', 'k-t1', done)
    await Bun.sleep(200)
    await w.finish('t2', 'k-t2', { ...done, durationMs: 400, cpuMs: 400 })
    await Promise.all(runs)
    // Side by side the longer ends it; one after the other, both.
    const apart = h.o.idealMs(() => [], sizes)!
    const chained = h.o.idealMs((id) => (id === 't2' ? ['t1'] : []), sizes)!
    expect(apart).toBeGreaterThanOrEqual(380)
    expect(apart).toBeLessThan(600)
    expect(chained - apart).toBeGreaterThanOrEqual(180)
  } finally {
    await h.stop()
  }
})

// Main 6a7224f: ideal 127.8 s above real 111.0 s. Mac shards ran five
// side by side at a 0.22 share; the replay kept their crowded length and
// booked the cores they would use free, so it ran them one at a time.
it('replays a crowded task with the cores it used, never above the real run', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const sizes = [{ name: 'small', max: 1, cpu: 2, memory: 1e10 }]
    const w = await h.worker(2)
    await Bun.sleep(50)
    const runs = [h.o.execute(h.req('t1')), h.o.execute(h.req('t2'))]
    await w.batches()
    await Bun.sleep(400)
    const crowded = { exitCode: 0, durationMs: 400, cpuMs: 400, cpuShare: 0.5 }
    await w.finish('t1', 'k-t1', crowded)
    await w.finish('t2', 'k-t2', crowded)
    await Promise.all(runs)
    expect(h.o.idealMs(() => [], sizes)!).toBeLessThan(600)
  } finally {
    await h.stop()
  }
})

// 2026-10-21: a worker the run's end stopped still read `online`, and
// a size's machines were a `!` line apart from its workers.
it('the final summary says how each worker ended, its size and machine under it', async () => {
  const h = await harness(new Map([node('t1')]))
  const small = { size: 'small', cpu: 2, memory: 4e9 }
  h.o.probed(3, 1)
  h.o.probed(9, 9)
  h.o.asked(2, 3, 1, 70_000, ['p#a', 'p#b'])
  h.o.spawned('small#1', small)
  h.o.spawned('big#1', { size: 'big', cpu: 4, memory: 4e9 })
  const a = await h.worker(2, 'small#1')
  const b = await h.worker(4, 'big#1')
  const c = await h.worker(1)
  await Bun.sleep(50)
  await c.leave()
  for (let i = 0; i < 40 && !JSON.stringify(h.o.footer()).includes('lost'); i++) await Bun.sleep(25)
  h.o.release([b.id])
  expect(await b.types()).toContain('exit')
  await h.stop()
  const rows = h.o.footer(() => 98_240).map(([, line]) => ui.inline(line, { enabled: false }))
  const at = (label: string) => rows.findIndex((r) => r.startsWith(label + ' '))
  expect(rows[at('worker#1')]).toMatch(/^worker#1 +lost/)
  expect(rows[at('small#1')]).toMatch(/^small#1 +stopped/)
  expect(rows[at('small#1') + 1]).toMatch(/^ +declared 2c\/4G · actual 2c\/0G$/)
  expect(rows[at('big#1')]).toMatch(/^big#1 +left/)
  expect(rows.some((r) => r.trimStart().startsWith('!'))).toBe(false)
  expect(rows.filter((r) => /^\S+ +online/.test(r))).toEqual([])
  // What the cache probe left to run, the first answer only: why the asks counted what they did.
  expect(rows.filter((r) => r.startsWith('probe'))).toEqual([
    expect.stringMatching(/^probe +at 0\.\ds: 3 tasks left to run, 1 known miss$/),
  ])
  // When the run asked for workers, for which work, and when its plan ended: why it had as many as it did.
  expect(rows.filter((r) => r.startsWith('asked'))).toEqual([
    expect.stringMatching(/^asked +2 at 0\.\ds for 3 tasks \(1 measured\), plan 70\.0s$/),
  ])
  // Every log carries how close the run came, beside core's time row (2026-10-23).
  expect(rows.filter((r) => r.startsWith('ideal'))).toEqual([
    expect.stringMatching(/^ideal +98\.2s: each task as long as it took, placed perfectly$/),
  ])
  // Main 68b851d: 41 of 119 unmeasured, each a whole worker, and the
  // summary said only how many (2026-10-23).
  expect(rows.filter((r) => r.startsWith('unmeasured'))).toEqual(['unmeasured  p#a, p#b'])
  // Tasks that reported no memory read `memory peak 0 B`.
  expect(rows.filter((r) => r.includes('memory peak'))).toEqual([])
  // A few hundred bytes read `0 KB`.
  expect(rows.filter((r) => r.includes(' 0 KB'))).toEqual([])
  expect(rows.some((r) => /^ +sent \d+ messages? · \d+ B, received/.test(r))).toBe(true)
  void a
})

// small#7 held 3.9 cores 61 s for one task using 0.3, and the summary
// did not say which task (main 68b851d, 2026-10-23).
it('the final summary names the tasks of a worker that ran few', async () => {
  const h = await harness(new Map([node('t1')]), undefined, 60_000)
  const a = await h.worker(1, 'small#7')
  await Bun.sleep(50)
  const t1 = h.o.execute(h.req('t1'))
  expect(await a.batches()).toEqual([['t1']])
  await a.begin('t1')
  await a.finish('t1')
  expect((await t1).exitCode).toBe(0)
  await h.stop()
  const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
  expect(rows.find((r) => r.includes('done'))).toMatch(/1 done · t1$/)
})

// Live, the workers that left are one line, so the rows that run fit.
it('lists the workers that left as one line while the run goes', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(4)
    const b = await h.worker(2)
    const c = await h.worker(2)
    await Bun.sleep(50)
    h.o.release([b.id, c.id])
    expect(await b.types()).toContain('exit')
    expect(await c.types()).toContain('exit')
    const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^worker#1 +online/)
    expect(rows[1]).toMatch(/^2 workers +left +0 done$/)
    void a
  } finally {
    await h.stop()
  }
})

// A lost worker's begun task runs again on another, two workers at most;
// one it had not begun goes back and does not count.
it('a task lost with two workers fails naming both; one not begun goes back free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    // Its failure lands while b leaves, before the test awaits it.
    const t1 = h.o.execute(h.req('t1')).then(
      () => '',
      (e: Error) => e.message,
    )
    const t2 = h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t1', 't2']])
    await a.begin('t1')
    await Bun.sleep(50)
    await a.leave()
    const b = await h.worker(2)
    expect(await b.batches()).toEqual([['t1', 't2']])
    await b.begin('t1')
    await b.begin('t2')
    await Bun.sleep(50)
    await b.leave()
    expect(await t1).toBe('t1: failed on 2 workers: worker#1 lost, worker#2 lost')
    const c = await h.worker(1)
    expect(await c.batches()).toEqual([['t2']])
    await c.finish('t2')
    expect((await t2).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
})

// An adapter that saw its worker's process or job end says so: its tasks
// went back when the relay stopped hearing it, 20 s later (2026-10-23).
it('a worker its adapter says exited is lost at once, its task run again', async () => {
  const h = await harness(new Map([node('t1')]), undefined, 60_000)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await Bun.sleep(50)
    h.o.failed('worker#1', 'exited 137')
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['t1']])
    await b.finish('t1')
    expect((await t1).exitCode).toBe(0)
    expect(h.o.machines().map((m) => [m.name, m.status])).toEqual([
      ['worker#2', 'ok'],
      ['worker#1', 'failed'],
    ])
  } finally {
    await h.stop()
  }
})

// Asked before the run's end, a worker still there read online 1 ms and
// booked 433802 of 4 (main, 2026-10-23).
it('reports a worker still there at the summary online until then', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(1)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await Bun.sleep(100)
    await a.finish('t1')
    expect((await t1).exitCode).toBe(0)
    const [m] = h.o.machines()
    expect(m!.status).toBe('ok')
    // A failed task is the task's, not its worker's (2026-10-23).
    const t2 = h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t2']])
    h.store.saved.set('k-t2', [])
    await a.say({ type: 'end', task: 't2', key: 'k-t2', result: { exitCode: 1, durationMs: 1 } })
    expect((await t2).exitCode).toBe(1)
    expect(h.o.machines()[0]!.status).toBe('ok')
    expect(m!.onlineMs).toBeGreaterThanOrEqual(100)
    expect(m!.bookedAvg).toBeLessThanOrEqual(m!.cores)
  } finally {
    await h.stop()
  }
})

// A worker whose upload failed (a remote's 500) was told to share a remote
// it already shared (2026-10-25).
it('a task whose entry reached no cache this machine reads names the upload first', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'end', task: 't1', key: 'k-t1', result: { exitCode: 0, durationMs: 1 } })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe(
      "t1: worker#1 ran it, and no cache this machine reads gave its entry, asked twice: a download failed (warned above), worker#1's upload failed (its log says why), or the workers and this machine share no remote cache the workers write",
    )
    expect(h.store.restored).toEqual(['k-t1', 'k-t1'])
  } finally {
    await h.stop()
  }
})

// One download from the cache Worker that stalled ("no bytes for 30000
// ms") failed a whole CI run, though the worker's upload had landed
// (main, 2026-10-28): a failed download reads as a miss here.
it('asks the caches again once for a task whose entry it could not read', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    let asked = 0
    const restore = h.store.artifacts.restore
    h.store.artifacts.restore = async (key, task) => (asked++ === 0 ? null : restore(key, task))
    h.store.saved.set('k-t1', [{ text: 'built\n', err: false }])
    const a = await h.worker(1)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'end', task: 't1', key: 'k-t1', result: { exitCode: 0, durationMs: 1 } })
    expect((await t1).exitCode).toBe(0)
    expect(asked).toBe(2)
  } finally {
    await h.stop()
  }
})

it('a worker that could not run a task it began gets no more; two such fail it', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    const b = await h.worker(2)
    expect(await b.batches()).toEqual([['t1']])
    void h.o.execute(h.req('t2'))
    expect(await b.batches()).toEqual([['t2']])
    await b.say({ type: 'fault', task: 't1', reason: 'unpack failed' })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('t1: failed on 2 workers: worker#1 ENOSPC, worker#2 unpack failed')
  } finally {
    await h.stop()
  }
})

it('a task a worker stops saying it holds goes back when its lease ends', async () => {
  // At 100 ms a beat, the test process held its loop past 190 ms once on
  // CI and its worker lost the orchestrator (main ae800d6, 2026-10-26).
  const beat = 300
  const h = await harness(new Map([node('t1')]), undefined, beat)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    // One `held` lasts three heartbeats: a worker says it every one.
    await a.say({ type: 'held', running: ['t1'], queued: [] })
    const said = performance.now()
    const b = await h.worker(1)
    // Alive, holding nothing: t1's lease ends and it moves.
    const alive = setInterval(() => void a.say({ type: 'held', running: [], queued: [] }), 50)
    try {
      let got: string[][] = []
      for (let i = 0; i < 3 && got.length === 0; i++) got = await b.batches()
      expect(got).toEqual([['t1']])
      // A `held` lasts three heartbeats: well under a lease of six.
      expect(performance.now() - said).toBeLessThan(6 * beat)
    } finally {
      clearInterval(alive)
    }
  } finally {
    await h.stop()
  }
})

// The relay restarts while a worker runs t1, and the orchestrator is away
// most of two heartbeats: past t1's lease, which no `held` renewed. It
// stays the worker's, not run again elsewhere (2026-10-25: "make
// sure on rejoin we don't repeat work").
it('a task held across a relay restart stays its worker’s: its lease waits for both to be back', async () => {
  const beat = 300
  const h = await harness(new Map([node('t1')]), undefined, beat)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await a.say({ type: 'held', running: ['t1'], queued: [] })
    const b = await h.worker(1)
    h.served.refuse = (r) => decodeURIComponent(r.url).includes('"role":"host"')
    h.served.restart()
    setTimeout(() => (h.served.refuse = undefined), 500)
    // Past the lease of 3 heartbeats from that `held`, 900 ms.
    const until = performance.now() + 1_200
    const got: string[] = []
    while (performance.now() < until)
      for (const m of await b.poll()) got.push((m.body as { type: string }).type)
    expect(got.filter((t) => t === 'batch')).toEqual([])
  } finally {
    await h.stop()
  }
})

// The loop expired leases before it read the batch it polled: a `held`
// read late came too late, and the task ran again on
// another worker (main CI, 2026-10-27).
it('a held read late renews its lease before the lease is judged', async () => {
  const beat = 300
  const h = await harness(new Map([node('t1')]), undefined, beat)
  // The poll in flight when `lag` is set returns its batch late.
  let lag = 0
  const me = (h.o as unknown as { o: { me: { poll: (s: AbortSignal) => Promise<unknown[]> } } }).o
    .me
  const poll = me.poll.bind(me)
  me.poll = async (signal) => {
    const got = await poll(signal)
    if (lag > 0) await Bun.sleep(lag)
    lag = 0
    return got
  }
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    const b = await h.worker(1)
    await a.say({ type: 'held', running: ['t1'], queued: [] })
    await Bun.sleep(beat * 2.3)
    // Said within the lease (3 beats), read after it: the loop was busy.
    lag = beat
    await a.say({ type: 'held', running: ['t1'], queued: [] })
    const until = performance.now() + beat * 2
    const got: string[] = []
    while (performance.now() < until)
      for (const m of await b.poll()) got.push((m.body as { type: string }).type)
    expect(got.filter((t) => t === 'batch')).toEqual([])
    expect(h.o.where('t1')).toBe('worker#1')
  } finally {
    await h.stop()
  }
})

// Main 32f73ed: a run stuck 13 min said nothing of what it waited on
// (2026-10-23).
it('a task whose command ended keeps its lease while its worker holds it, and a quiet run says what it waits on', async () => {
  const waiting: string[] = []
  // A quiet worker is probed at 1.5 heartbeats and lost at 1.9: at 100 ms,
  // 40 ms of a loaded runner's stall lost the new worker (CI, 2026-10-25).
  const beat = 200
  const h = await harness(new Map([node('t1')]), undefined, beat, undefined, undefined, {
    stalled: (w) => waiting.push(w),
    stallMs: 300,
  })
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    // Held each beat from the batch on, as a worker says it. Begun after
    // `ran` and `b`'s join, a runner's 400 ms stall there ended the lease
    // before the first `held` (CI, 2026-10-28).
    const alive = setInterval(() => void a.say({ type: 'held', running: ['t1'] }), beat)
    try {
      await a.begin('t1')
      await a.say({ type: 'ran', task: 't1' })
      const b = await h.worker(1)
      // Saving, it still holds t1: past a run's lease (0.6 s here), t1 stays.
      expect(await b.batches()).toEqual([])
      expect(await b.batches()).toEqual([])
    } finally {
      clearInterval(alive)
    }
    expect(h.o.where('t1')).toBe('worker#1')
    expect(waiting[0]).toMatch(/^t1 on worker#1: saving its outputs for \d+ s$/)
  } finally {
    await h.stop()
  }
}, 15_000)

// An additive task rewrites its upstream's file: restored after it, the
// upstream put the old bytes back (2026-10-25).
it('an order lists each dependency after its own dependencies', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      {
        id,
        deps,
        projectDir: '/ws/a',
        config: { cache: { outputs: { files: ['dist/**'] } } },
      } as unknown as TaskNode,
    ] as const
  const h = await harness(
    new Map([cached('one'), cached('two', ['one']), cached('three', ['two', 'one'])]),
    undefined,
    undefined,
    (id) => `k-${id}`,
  )
  try {
    const a = await h.worker(1)
    void h.o.execute(h.req('three', 'k-three'))
    expect(await a.batches()).toEqual([['three']])
    expect(a.orders[0]!.deps.map((d) => d.task)).toEqual(['one', 'two'])
  } finally {
    await h.stop()
  }
})

// 2026-10-21: files go through the cache, the relay carries only
// orders and status.
it('an order names its key and each dependency’s; the result comes back by the key its worker saved', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      {
        id,
        deps,
        projectDir: `/ws/${id}`,
        config: { cache: { outputs: { files: ['dist/**'] } } },
      } as unknown as TaskNode,
    ] as const
  const h = await harness(
    new Map([
      cached('lib'),
      cached('mid', ['lib']),
      cached('app', ['mid']),
      cached('top', ['mid']),
    ]),
    undefined,
    undefined,
    (id) => (id === 'lib' ? 'k-lib-hit' : undefined),
  )
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const mid = h.o.execute(h.req('mid', 'k-mid'))
    expect(await a.batches()).toEqual([['mid']])
    expect(a.orders[0]).toMatchObject({
      task: 'mid',
      key: 'k-mid',
      runKey: runKey(R, 'mid'),
      deps: [{ task: 'lib', key: 'k-lib-hit', project: 'lib', outputs: { files: ['dist/**'] } }],
    })
    // A failure is saved under its run key.
    await a.finish('mid', runKey(R, 'mid'))
    const got = await mid
    expect(got.stdout).toBe('mid out\n')
    expect(h.store.restored).toEqual([runKey(R, 'mid')])
    void h.o.execute(h.req('app', 'k-app'))
    expect(await a.batches()).toEqual([['app']])
    // Named though it holds them: the worker restores each key once.
    expect(a.orders.find((o) => o.task === 'app')!.deps.map((d) => [d.task, d.key])).toEqual([
      ['lib', 'k-lib-hit'],
      ['mid', runKey(R, 'mid')],
    ])
    const b = await h.worker(1)
    await Bun.sleep(50)
    // Another worker, with room where the first has none, is sent both.
    void h.o.execute(h.req('top', 'k-top'))
    expect(await b.batches()).toEqual([['top']])
    expect(b.orders[0]!.deps.map((d) => [d.task, d.key])).toEqual([
      ['lib', 'k-lib-hit'],
      ['mid', runKey(R, 'mid')],
    ])
    // The hit, held here, put where workers read before its first order;
    // the key a worker saved is there already.
    expect(h.store.shared).toEqual(['k-lib-hit'])
  } finally {
    await h.stop()
  }
})

// A defined HOME ran with the worker's own, saved under a key that folded
// the defined one (2026-10-24).
it('sends a host name such as HOME only when the task’s env.define sets it', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute({
      ...h.req('t1'),
      env: { HOME: '/orc/home', XDG_RUNTIME_DIR: '/run/user/1', TMPDIR: '/defined/tmp', X: '1' },
      envDefine: { TMPDIR: '/defined/tmp' },
    })
    expect(await a.batches()).toEqual([['t1']])
    expect(a.orders[0]!.env).toEqual({ TMPDIR: '/defined/tmp', X: '1' })
  } finally {
    await h.stop()
  }
})

// A remote keeps the first bytes put under a key: a retry saved under its
// first attempt's run key replayed that failure under a green result
// (2026-10-24).
it('saves each send of a task under a run key of its own', async () => {
  const h = await harness(new Map([node('t')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const first = h.o.execute(h.req('t'))
    expect(await a.batches()).toEqual([['t']])
    await a.finish('t', a.orders[0]!.runKey)
    await first
    void h.o.execute(h.req('t'))
    expect(await a.batches()).toEqual([['t']])
    expect(a.orders.map((o) => o.runKey)).toEqual([runKey(R, 't'), runKey(R, 't', 1)])
    expect(runKey(R, 't', 1)).not.toBe(runKey(R, 't'))
  } finally {
    await h.stop()
  }
})

// A dependency's remote copy that did not read back (a truncated upload)
// failed its dependant on every worker and every run: the remote said it
// held the key, so this machine's copy never went over it (2026-10-25).
it('sends a dependency a worker could not read over the remotes’ copy, and the task again', async () => {
  const h = await harness(new Map([node('t')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const ran = h.o.execute(h.req('t'))
    expect(await a.batches()).toEqual([['t']])
    const unread = { exitCode: 1, durationMs: 0, unread: ['k-d'] }
    await a.finish('t', a.orders[0]!.runKey, unread)
    expect(await a.batches()).toEqual([['t']])
    expect(h.store.shared).toEqual(['k-d again'])
    // Sent once: the next fails the task.
    await a.finish('t', a.orders[1]!.runKey, unread)
    expect((await ran).exitCode).toBe(1)
    expect(h.store.shared).toEqual(['k-d again'])
  } finally {
    await h.stop()
  }
})

// A worker ended its task and held it no more while this machine sent a
// dependency it could not read again, longer than a lease: the lease
// ending meanwhile called the worker faulty and gave the task to another.
for (const sent of [true, false])
  it(`a task ended while its dependency is sent again keeps no lease (${sent ? 'sent' : 'not sent'})`, async () => {
    const beat = 300
    const faults: string[] = []
    const h = await harness(new Map([node('t')]), undefined, beat, undefined, undefined, {
      faulted: () => faults.push('faulted'),
    })
    // Past the lease of 3 heartbeats.
    h.store.artifacts.resend = async () => (await Bun.sleep(4 * beat), sent)
    try {
      const a = await h.worker(1)
      await Bun.sleep(50)
      const ran = h.o.execute(h.req('t'))
      expect(await a.batches()).toEqual([['t']])
      await a.begin('t')
      const b = await h.worker(1)
      await a.finish('t', a.orders[0]!.runKey, { exitCode: 1, durationMs: 0, unread: ['k-d'] })
      const until = performance.now() + 6 * beat
      const toB: string[] = []
      while (performance.now() < until)
        for (const m of await b.poll()) toB.push((m.body as { type: string }).type)
      expect(toB.filter((t) => t === 'batch')).toEqual([])
      expect(faults).toEqual([])
      if (sent) expect(await a.batches()).toEqual([['t']])
      else expect((await ran).exitCode).toBe(1)
    } finally {
      await h.stop()
    }
  })

// Its worker lost meanwhile, the task went back to the queue, and the end
// that waited on the resend still resolved it: it ran again on another
// worker for a run that had moved on.
it('a task whose worker is lost while its dependency is sent again ends once', async () => {
  const h = await harness(new Map([node('t')]))
  let sending!: () => void
  const sent = new Promise<void>((r) => (sending = r))
  h.store.artifacts.resend = async () => (await sent, false)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    let ends = 0
    const ran = h.o.execute(h.req('t')).then((r) => (ends++, r))
    expect(await a.batches()).toEqual([['t']])
    await a.finish('t', a.orders[0]!.runKey, { exitCode: 1, durationMs: 0, unread: ['k-d'] })
    await Bun.sleep(100)
    await a.leave()
    for (let i = 0; i < 50 && h.o.where('t') === undefined; i++) await Bun.sleep(20)
    expect(h.o.where('t')).toBeNull()
    sending()
    await Bun.sleep(100)
    expect(ends).toBe(0)
    expect(h.o.where('t')).toBeNull()
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['t']])
    await b.finish('t', b.orders[0]!.runKey)
    expect((await ran).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
})

// A batch the relay refused failed its task and left it booked on its
// worker, with no lease to end it: the worker's cores were gone for the
// run, and the next task waited on them for good.
it('a task whose batch the relay refused leaves its worker’s cores free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  const me = (h.o as unknown as { o: { me: { send: (to: string, b: unknown) => Promise<void> } } })
    .o.me
  const send = me.send.bind(me)
  let refuse = true
  me.send = async (to, body) => {
    if (refuse && (body as { type: string }).type === 'batch') {
      refuse = false
      throw new RelayError(413, 'relay send: 413 too large')
    }
    return send(to, body)
  }
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('relay send: 413 too large')
    expect(h.o.where('t1')).toBeUndefined()
    void h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t2']])
  } finally {
    await h.stop()
  }
})

it('a refused batch fails only its own tasks, not those of a part sent before it', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  const me = (h.o as unknown as { o: { me: { send: (to: string, b: unknown) => Promise<void> } } })
    .o.me
  const send = me.send.bind(me)
  let batches = 0
  me.send = async (to, body) => {
    if ((body as { type: string }).type === 'batch' && ++batches === 2)
      throw new RelayError(413, 'relay send: 413 too large')
    return send(to, body)
  }
  // Each order past half the batch limit: two parts.
  const big = (id: string) => ({ ...h.req(id), env: { BIG: 'x'.repeat(300 * 1024) } })
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    let first = 'pending'
    void h.o.execute(big('t1')).then(
      () => (first = 'ended'),
      (e: Error) => (first = e.message),
    )
    const t2 = h.o.execute(big('t2')).then(
      () => '',
      (e: Error) => e.message,
    )
    expect(await a.batches()).toEqual([['t1']])
    expect(await t2).toBe('relay send: 413 too large')
    expect(first).toBe('pending')
    expect(h.o.where('t1')).toBeNull()
  } finally {
    await h.stop()
  }
})

// A task sent again over a dependency it could not read left its cores
// booked on its worker for the rest of the run: the summary's booked avg
// climbed while the worker sat idle.
it('a task sent again over a dependency it could not read gives its booked cores back', async () => {
  const h = await harness(new Map([node('t')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const ran = h.o.execute(h.req('t'))
    expect(await a.batches()).toEqual([['t']])
    await a.begin('t')
    await a.finish('t', a.orders[0]!.runKey, { exitCode: 1, durationMs: 0, unread: ['k-d'] })
    expect(await a.batches()).toEqual([['t']])
    await a.begin('t')
    await a.finish('t')
    expect((await ran).exitCode).toBe(0)
    const before = h.o.machines()[0]!.bookedAvg!
    await Bun.sleep(300)
    expect(h.o.machines()[0]!.bookedAvg).toBeLessThan(before)
  } finally {
    await h.stop()
  }
})

// Two dependants of one dependency fail to read it together: the first's
// end sent it again and ran it again, the second's found the key sent and
// failed its task, though the copy it could not read was now replaced.
it('runs again each task that could not read a dependency sent again for them', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    const ran = [h.o.execute(h.req('t1')), h.o.execute(h.req('t2'))]
    expect((await a.batches()).flat().sort()).toEqual(['t1', 't2'])
    const unread = { exitCode: 1, durationMs: 0, unread: ['k-d'] }
    const key = (t: string) => a.orders.find((o) => o.task === t)!.runKey
    await a.finish('t1', key('t1'), unread)
    await a.finish('t2', key('t2'), unread)
    const t2 = await Promise.race([ran[1]!.then((r) => r.exitCode), Bun.sleep(300)])
    expect(t2).toBeUndefined()
    const again: string[] = []
    while (again.length < 2) {
      const b = (await a.batches()).flat()
      if (b.length === 0) break
      again.push(...b)
    }
    expect(again.sort()).toEqual(['t1', 't2'])
    expect(h.store.shared).toEqual(['k-d again'])
    const resends = a.orders.slice(2)
    for (const o of resends) await a.finish(o.task, o.runKey)
    expect((await Promise.all(ran)).map((r) => r.exitCode)).toEqual([0, 0])
  } finally {
    await h.stop()
  }
})

// `vx watch` runs again under one run id: its next run sent a task under
// the last run's run key, which a remote holds the first bytes of
// (2026-10-24).
it('counts a task’s sends across the runs that share a sent map', async () => {
  const sent = new Map<string, number>()
  const keys: string[] = []
  for (let i = 0; i < 2; i++) {
    const h = await harness(new Map([node('t')]), undefined, undefined, undefined, undefined, {
      sent,
    })
    try {
      const a = await h.worker(1)
      await Bun.sleep(50)
      void h.o.execute(h.req('t'))
      expect(await a.batches()).toEqual([['t']])
      keys.push(a.orders[0]!.runKey)
    } finally {
      await h.stop()
    }
  }
  expect(keys).toEqual([runKey(R, 't'), runKey(R, 't', 1)])
})

it('sends a task to the worker that holds its dependency’s outputs', async () => {
  const h = await harness(new Map([node('x'), node('y', ['x'])]))
  try {
    const small = await h.worker(1)
    await Bun.sleep(50)
    const ran = h.o.execute(h.req('x'))
    expect(await small.batches()).toEqual([['x']])
    await small.finish('x')
    await ran
    const big = await h.worker(8)
    await Bun.sleep(50)
    void h.o.execute(h.req('y'))
    expect(await small.batches()).toEqual([['y']])
    void big
  } finally {
    await h.stop()
  }
})

// A worker that gave a task back had never run it, yet the orchestrator
// counted its outputs there: a dependant sent to that worker was ordered
// with no dependency to restore, and ran without its files (2026-10-22).
it('an order names every dependency, held by its worker or not', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      {
        id,
        deps,
        projectDir: `/ws/${id}`,
        config: { cache: { outputs: { files: ['dist/**'] } } },
      } as unknown as TaskNode,
    ] as const
  const h = await harness(new Map([cached('t1'), cached('x'), cached('w'), cached('y', ['x'])]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    void h.o.execute(h.req('x', 'k-x'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['x']])
    await b.finish('x', 'k-x')
    void h.o.execute(h.req('w'))
    expect(await b.batches()).toEqual([['w']])
    await b.begin('w')
    await a.finish('t1')
    await t1
    void h.o.execute(h.req('y'))
    expect(await a.batches()).toEqual([['y']])
    expect(a.orders.find((o) => o.task === 'y')!.deps.map((d) => [d.task, d.key])).toEqual([
      ['x', 'k-x'],
    ])
  } finally {
    await h.stop()
  }
})

// An uncached task declares no outputs, so no cache carries its files:
// two generators ran on two workers and their dependant, on one, did not
// find the other's file (#4407). Its dependants go where its files are;
// with them on two workers, one runs again beside the other (2026-10-25).
it('an uncached task’s dependant goes to the worker holding its files, made again there when split', async () => {
  const h = await harness(new Map([node('g1'), node('g2'), node('u', ['g1', 'g2'])]))
  try {
    const a = await h.worker(1, 'a')
    const b = await h.worker(1, 'b')
    const g1 = h.o.execute(h.req('g1'))
    const g2 = h.o.execute(h.req('g2'))
    const [onA, onB] = [await a.batches(), await b.batches()]
    expect([...onA, ...onB].flat().sort()).toEqual(['g1', 'g2'])
    const [first, second] = onA.flat()[0] === 'g1' ? [a, b] : [b, a]
    await first.finish('g1', runKey(R, 'g1'))
    await second.finish('g2', runKey(R, 'g2'))
    await Promise.all([g1, g2])
    const u = h.o.execute(h.req('u'))
    // g2 again where g1 lies, then u there: never u beside one alone.
    expect(await first.batches()).toEqual([['g2']])
    await first.finish('g2', runKey(R, 'g2', 1))
    expect(await first.batches()).toEqual([['u']])
    await first.finish('u', runKey(R, 'u'))
    expect((await u).exitCode).toBe(0)
    expect(second.orders.map((o) => o.task)).toEqual(['g2'])
  } finally {
    await h.stop()
  }
})

it('an uncached task’s dependant waits on its worker, then has it made again on another', async () => {
  const h = await harness(
    new Map([node('g'), node('x'), node('u', ['g'])]),
    undefined,
    undefined,
    undefined,
    undefined,
    { pinWaitMs: 200 },
  )
  try {
    const a = await h.worker(1, 'a')
    const g = h.o.execute(h.req('g'))
    expect(await a.batches()).toEqual([['g']])
    await a.finish('g', runKey(R, 'g'))
    await g
    void h.o.execute(h.req('x'))
    expect(await a.batches()).toEqual([['x']])
    const b = await h.worker(1, 'b')
    const began = performance.now()
    const u = h.o.execute(h.req('u'))
    // a stays full with x: past the wait, g runs again on b, and u follows it.
    expect(await b.batches()).toEqual([['g']])
    expect(performance.now() - began).toBeGreaterThanOrEqual(150)
    await b.finish('g', runKey(R, 'g', 1))
    expect(await b.batches()).toEqual([['u']])
    await b.finish('u', runKey(R, 'u'))
    expect((await u).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
})

it('an uncached task made again for its dependant and failing fails the dependant, saying why', async () => {
  const h = await harness(
    new Map([node('g'), node('x'), node('u', ['g'])]),
    undefined,
    undefined,
    undefined,
    undefined,
    { pinWaitMs: 100 },
  )
  try {
    const a = await h.worker(1, 'a')
    const g = h.o.execute(h.req('g'))
    expect(await a.batches()).toEqual([['g']])
    await a.finish('g', runKey(R, 'g'))
    await g
    void h.o.execute(h.req('x'))
    expect(await a.batches()).toEqual([['x']])
    const b = await h.worker(1, 'b')
    const u = h.o.execute(h.req('u'))
    expect(await b.batches()).toEqual([['g']])
    await b.finish('g', runKey(R, 'g', 1), { exitCode: 2, durationMs: 1 })
    const got = await u
    expect(got.exitCode).toBe(1)
    expect(got.stderr).toBe('g ran again for it and failed (exit 2)\n')
  } finally {
    await h.stop()
  }
})

// Every test shard depends, through install, on an uncached sandboxed
// version check: pinned to its worker, the run's mac shards waited on a
// linux worker for 12 minutes (#4425's CI). A sandbox with no write grant
// leaves no file, so nothing follows it.
it('an uncached sandboxed task with no write grant leaves nothing: its dependant goes anywhere', async () => {
  const gate = (id: string) =>
    [
      id,
      {
        id,
        deps: [],
        projectDir: '/ws',
        config: { exec: { command: 'x', sandbox: { allow: { read: ['.'] } } } },
      },
    ] as unknown as readonly [string, TaskNode]
  const h = await harness(new Map([gate('g'), node('x'), node('u', ['g'])]))
  try {
    const a = await h.worker(1, 'a')
    const g = h.o.execute(h.req('g'))
    expect(await a.batches()).toEqual([['g']])
    await a.finish('g', runKey(R, 'g'))
    await g
    void h.o.execute(h.req('x'))
    expect(await a.batches()).toEqual([['x']])
    const b = await h.worker(1, 'b')
    void h.o.execute(h.req('u'))
    expect(await b.batches()).toEqual([['u']])
  } finally {
    await h.stop()
  }
})

it('an uncached task’s dependant on another platform has it made again on a worker of that one', async () => {
  const h = await harness(new Map([node('g'), node('u', ['g'])]))
  try {
    const linux = await h.worker(2, 'l', 'linux-x64')
    const g = h.o.execute({ ...h.req('g'), platform: 'linux-x64' })
    expect(await linux.batches()).toEqual([['g']])
    await linux.finish('g', runKey(R, 'g'))
    await g
    const mac = await h.worker(2, 'm', 'darwin-arm64')
    await Bun.sleep(50)
    const u = h.o.execute({ ...h.req('u'), platform: 'darwin-arm64' })
    expect(await mac.batches()).toEqual([['g']])
    await mac.finish('g', runKey(R, 'g', 1))
    expect(await mac.batches()).toEqual([['u']])
    await mac.finish('u', runKey(R, 'u'))
    expect((await u).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
})

it('a cached task’s dependant goes wherever it fits: a cache carries its outputs', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      { id, deps, projectDir: '/ws', config: { cache: { outputs: { files: ['out/**'] } } } },
    ] as unknown as readonly [string, TaskNode]
  const h = await harness(new Map([cached('g'), cached('x'), cached('u', ['g'])]))
  try {
    const a = await h.worker(1, 'a')
    const g = h.o.execute(h.req('g', 'k-g'))
    expect(await a.batches()).toEqual([['g']])
    await a.finish('g')
    await g
    void h.o.execute(h.req('x', 'k-x'))
    expect(await a.batches()).toEqual([['x']])
    const b = await h.worker(1, 'b')
    void h.o.execute(h.req('u', 'k-u'))
    expect(await b.batches()).toEqual([['u']])
  } finally {
    await h.stop()
  }
})

// A worker whose upload no remote took (too big, a 429) said it was saved,
// and the run failed restoring it (2026-10-25): its files stay there,
// its dependants go there, and its output comes with its `end`.
it('a task no remote took the upload of: its output comes with it, its dependant follows it', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      { id, deps, projectDir: '/ws', config: { cache: { outputs: { files: ['out/**'] } } } },
    ] as unknown as readonly [string, TaskNode]
  const h = await harness(new Map([cached('g'), cached('x'), cached('u', ['g'])]))
  try {
    const a = await h.worker(1, 'a')
    const g = h.o.execute(h.req('g', 'k-g'))
    expect(await a.batches()).toEqual([['g']])
    await a.finish('g', 'k-g', {
      exitCode: 0,
      durationMs: 1,
      unshared: true,
      output: [
        { text: 'built\n', err: false },
        { text: 'warned\n', err: true },
      ],
    })
    const got = await g
    expect([got.stdout, got.stderr]).toEqual(['built\n', 'warned\n'])
    if (got.outputs?.kind !== 'deferred') throw new Error('expected deferred outputs')
    await expect(got.outputs.materialize()).rejects.toThrow('g: its files are on worker#1 alone')
    void h.o.execute(h.req('x', 'k-x'))
    expect(await a.batches()).toEqual([['x']])
    const b = await h.worker(1, 'b')
    const u = h.o.execute(h.req('u', 'k-u'))
    await Bun.sleep(100)
    await a.finish('x')
    expect(await a.batches()).toEqual([['u']])
    await a.finish('u')
    expect((await u).exitCode).toBe(0)
    expect(b.orders).toEqual([])
  } finally {
    await h.stop()
  }
})

// A worker asked the remote before each upload (a HEAD per task on
// turboCache()), though the run's probe had found the key in no cache:
// requests the Vercel free tier's 300 a minute refused (2026-10-25).
it('a worker uploads a key the run found missing, and its run key, asking the remote nothing first', async () => {
  const h = await harness(new Map([node('t'), node('u')]))
  try {
    const a = await h.worker(2)
    h.o.missed = new Set(['t'])
    void h.o.execute(h.req('t', 'k-t'))
    void h.o.execute(h.req('u', 'k-u'))
    expect((await a.batches()).flat().sort()).toEqual(['t', 'u'])
    const of = (id: string) => a.orders.find((o) => o.task === id)
    expect(of('t')?.absent).toBe(true)
    expect(of('u')?.absent).toBeUndefined()
  } finally {
    await h.stop()
  }
  const root = await checkout()
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const saved: [string, boolean | undefined][] = []
    const artifacts: TaskArtifacts = {
      async save(key, _task, run) {
        saved.push([key, run.absent])
      },
      async output() {
        return null
      },
      async share() {
        return false
      },
      async resend() {
        return false
      },
      async restore() {
        return null
      },
    }
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order = (task: string, command: string, absent: boolean): RunOrder => ({
      task,
      key: `k-${task}`,
      runKey: runKey(R, task),
      ...(absent ? { absent: true as const } : {}),
      deps: [],
      nested: [],
      command,
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    const tasks = [order('t', 'true', true), order('u', 'true', false), order('v', 'exit 1', false)]
    let ended = 0
    for (let i = 0; i < 100 && ended < tasks.length; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 3,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks })
        } else if (m.type === 'end' && ++ended === tasks.length)
          await o.send(from, { type: 'exit' })
      }
    expect(await code).toBe(0)
    expect(new Map(saved)).toEqual(
      new Map<string, boolean | undefined>([
        ['k-t', true],
        ['k-u', undefined],
        [runKey(R, 'v'), true],
      ]),
    )
  } finally {
    await served.stop()
  }
})

it('a worker says which task no remote took the upload of, sending its output with it', async () => {
  const root = await checkout()
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const artifacts: TaskArtifacts = {
      async save() {},
      async output() {
        return null
      },
      async share() {
        return false
      },
      async resend() {
        return false
      },
      async restore() {
        return null
      },
      async uploaded(key) {
        return key === 'k-t' ? false : key === 'k-u' ? true : undefined
      },
    }
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order = (task: string): RunOrder => ({
      task,
      key: `k-${task}`,
      runKey: runKey(R, task),
      deps: [],
      nested: [],
      command: `echo ${task}`,
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    const tasks = [order('t'), order('u'), order('v')]
    const ends = new Map<string, WiredResult>()
    for (let i = 0; i < 100 && ends.size < tasks.length; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string; task?: string; result?: WiredResult }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 3,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks })
        } else if (m.type === 'end') {
          ends.set(m.task!, m.result!)
          if (ends.size === tasks.length) await o.send(from, { type: 'exit' })
        }
      }
    expect(await code).toBe(0)
    expect([ends.get('t')?.unshared, ends.get('t')?.output]).toEqual([
      true,
      [{ text: 't\n', err: false }],
    ])
    for (const t of ['u', 'v'])
      expect([ends.get(t)?.unshared, ends.get(t)?.output]).toEqual([undefined, undefined])
  } finally {
    await served.stop()
  }
})

// Under `--force` a held key kept its entry, and the orchestrator restored
// the bytes the run bypassed over the ones its worker built (2026-10-25).
it('a forced run’s order is fresh, and its worker saves a success under the run key too', async () => {
  const h = await harness(new Map([node('t')]))
  try {
    const a = await h.worker(1)
    void h.o.execute({ ...h.req('t', 'k-t'), refresh: true } as ExecuteRequest)
    expect(await a.batches()).toEqual([['t']])
    expect(a.orders[0]).toMatchObject({ key: 'k-t', fresh: true })
  } finally {
    await h.stop()
  }
  const root = await checkout()
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const saved: string[] = []
    const artifacts: TaskArtifacts = {
      async save(key) {
        saved.push(key)
      },
      async output() {
        return null
      },
      async share() {
        return false
      },
      async resend() {
        return false
      },
      async restore() {
        return null
      },
    }
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order: RunOrder = {
      task: 't',
      key: 'k-t',
      runKey: runKey(R, 't'),
      fresh: true,
      deps: [],
      nested: [],
      command: 'true',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    let ended: string | undefined
    for (let i = 0; i < 100 && ended === undefined; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string; key?: string }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'end') {
          ended = m.key
          await o.send(from, { type: 'exit' })
        }
      }
    expect(await code).toBe(0)
    expect(saved).toEqual(['k-t', runKey(R, 't')])
    expect(ended).toBe(runKey(R, 't'))
  } finally {
    await served.stop()
  }
})

it('a worker’s output is saved and replayed in the order the task wrote it', async () => {
  const h = await harness(new Map([node('t')]))
  try {
    const a = await h.worker(1)
    const seen: string[] = []
    const t = h.o.execute({
      ...h.req('t', 'k-t'),
      onStdout: (s: string) => seen.push(`out ${s}`),
      onStderr: (s: string) => seen.push(`err ${s}`),
    } as ExecuteRequest)
    expect(await a.batches()).toEqual([['t']])
    h.store.saved.set('k-t', [
      { text: 'a\n', err: false },
      { text: 'b\n', err: true },
      { text: 'c\n', err: false },
    ])
    await a.say({ type: 'end', task: 't', key: 'k-t', result: { exitCode: 0, durationMs: 1 } })
    const got = await t
    expect(seen).toEqual(['out a\n', 'err b\n', 'out c\n'])
    expect([got.stdout, got.stderr]).toEqual(['a\nc\n', 'b\n'])
  } finally {
    await h.stop()
  }
  const root = await tmp()
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    let output: readonly CapturedChunk[] = []
    const artifacts: TaskArtifacts = {
      async save(_key, _task, run) {
        output = run.output
      },
      async output() {
        return null
      },
      async share() {
        return false
      },
      async resend() {
        return false
      },
      async restore() {
        return null
      },
    }
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order: RunOrder = {
      task: 't',
      key: 'k-t',
      runKey: runKey(R, 't'),
      deps: [],
      nested: [],
      command: 'echo a; sleep 0.2; echo b >&2; sleep 0.2; echo c',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    let ended = false
    for (let i = 0; i < 100 && !ended; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'end') {
          ended = true
          await o.send(from, { type: 'exit' })
        }
      }
    expect(await code).toBe(0)
    expect(output).toEqual([
      { text: 'a\n', err: false },
      { text: 'b\n', err: true },
      { text: 'c\n', err: false },
    ])
  } finally {
    await served.stop()
  }
})

// Two tasks begun together needing one dependency: the one whose order
// did not carry it ran before the other had restored it (2026-10-22).
it('a worker restores a dependency once, before any task that needs it runs', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const o = sealOrchestrator(
      await join(url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    let restores = 0
    const artifacts: TaskArtifacts = {
      async save() {},
      async output() {
        return null
      },
      async share() {
        return false
      },
      async resend() {
        return false
      },
      async restore() {
        restores++
        await Bun.sleep(100)
        await writeFile(path.join(root, 'dep.txt'), 'd')
        return []
      },
    }
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order = (task: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [
        { task: 'd', key: 'k-d', project: '', outputs: { files: ['dep.txt'], workspaceFiles: [] } },
      ],
      nested: [],
      command: 'test -f dep.txt',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    const ends: { task: string; exitCode: number }[] = []
    for (let i = 0; i < 100 && ends.length < 2; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          task?: string
          result?: { exitCode: number }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, {
            type: 'batch',
            root,
            realRoot: root,
            tasks: [order('t1'), order('t2')],
          })
        } else if (m.type === 'end') {
          ends.push({ task: m.task!, exitCode: m.result!.exitCode })
          if (ends.length === 2) await o.send(from, { type: 'exit' })
        }
      }
    }
    expect(await code).toBe(0)
    expect(ends.toSorted((x, y) => x.task.localeCompare(y.task))).toEqual([
      { task: 't1', exitCode: 0 },
      { task: 't2', exitCode: 0 },
    ])
    expect(restores).toBe(1)
  } finally {
    await served.stop()
  }
})

// A dependency in no cache the worker read was its fault: each worker it
// reached was dropped, and the run waited on one that never came
// (2026-10-24).
it('a worker fails a task whose dependency is in no cache it reads, and stays', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const o = sealOrchestrator(
      await join(url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const saved: string[] = []
    const artifacts: TaskArtifacts = {
      async save(key) {
        saved.push(key)
      },
      async output() {
        return null
      },
      async share() {
        return false
      },
      async resend() {
        return false
      },
      async restore() {
        return null
      },
    }
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order: RunOrder = {
      task: 't1',
      key: 'k-t1',
      runKey: runKey(R, 't1'),
      deps: [
        { task: 'd', key: 'k-d', project: '', outputs: { files: ['dep.txt'], workspaceFiles: [] } },
      ],
      nested: [],
      command: 'true',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    const got: { type: string; key?: string; result?: { exitCode: number } }[] = []
    for (let i = 0; i < 100 && got.length === 0; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string; key?: string; result?: { exitCode: number } }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'end' || m.type === 'fault') {
          got.push(m)
          await o.send(from, { type: 'exit' })
        }
      }
    }
    expect(await code).toBe(0)
    expect(got).toMatchObject([
      { type: 'end', key: runKey(R, 't1'), result: { exitCode: 1, unread: ['k-d'] } },
    ])
    expect(saved).toEqual([runKey(R, 't1')])
  } finally {
    await served.stop()
  }
})

// A task whose outputs overlap a restored dependency's cleared its files,
// and a later task that needed them ran without them: the worker still
// counted them restored (2026-10-22).
it('a worker restores a dependency again after a task cleared its files', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const o = sealOrchestrator(
      await join(url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    let restores = 0
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save() {},
        async output() {
          return null
        },
        async share() {
          return false
        },
        async resend() {
          return false
        },
        async restore() {
          restores++
          await mkdir(path.join(root, 'p/dist'), { recursive: true })
          await writeFile(path.join(root, 'p/dist/a.txt'), 'd')
          return []
        },
      }),
    })
    const dist: RunOrder['outputs'] = { files: ['dist/**'], workspaceFiles: [] }
    const order = (
      task: string,
      deps: boolean,
      outputs: RunOrder['outputs'] = { files: [], workspaceFiles: [] },
    ) =>
      ({
        task,
        runKey: runKey(R, task),
        deps: deps ? [{ task: 'd', key: 'k-d', project: 'p', outputs: dist }] : [],
        nested: [],
        command: deps ? 'test -f p/dist/a.txt' : 'true',
        cwd: '',
        project: 'p',
        env: {},
        outputs,
        cores: 1,
        memory: 0,
      }) as RunOrder
    const tasks = [order('t1', true), order('t2', false, dist), order('t3', true)]
    const ends: { task: string; exitCode: number }[] = []
    for (let i = 0; i < 100 && ends.length < 3; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          task?: string
          result?: { exitCode: number }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [tasks[0]!] })
        } else if (m.type === 'end') {
          ends.push({ task: m.task!, exitCode: m.result!.exitCode })
          // One at a time, as the run sends a worker of 1 core.
          if (ends.length === 3) await o.send(from, { type: 'exit' })
          else
            await o.send(from, {
              type: 'batch',
              root,
              realRoot: root,
              tasks: [tasks[ends.length]!],
            })
        }
      }
    }
    expect(await code).toBe(0)
    expect(ends).toEqual([
      { task: 't1', exitCode: 0 },
      { task: 't2', exitCode: 0 },
      { task: 't3', exitCode: 0 },
    ])
    expect(restores).toBe(2)
  } finally {
    await served.stop()
  }
})

// A stopped run whose worker was lost before it answered the cancel waited
// on that task forever (2026-10-22).
it('a task stopped while its worker is lost ends as stopped', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const stop = new AbortController()
    const t1 = h.o.execute({ ...h.req('t1'), signal: stop.signal })
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await Bun.sleep(20)
    stop.abort()
    expect(await a.bodies()).toEqual([{ type: 'cancel', task: 't1' }])
    await a.leave()
    expect(await t1).toMatchObject({ exitCode: 130 })
  } finally {
    await h.stop()
  }
}, 3_000)

// A task handed over already stopped was queued and run in full: its
// signal's abort had fired before anyone listened (2026-10-22).
it('a task handed over already stopped ends as stopped', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const stop = new AbortController()
    stop.abort()
    expect(await h.o.execute({ ...h.req('t1'), signal: stop.signal })).toMatchObject({
      exitCode: 130,
    })
  } finally {
    await h.stop()
  }
}, 3_000)

// A run's only worker faulted on a task: no worker was left to run it, none
// was starting, and the run waited forever (2026-10-22).
it('a task its only worker could not run fails when no worker is left', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    // Its join sets the size's join limit at twice its warm-up: joined at
    // once, small#2 had 0 s on a busy CI machine (PR #4162).
    await Bun.sleep(500)
    const a = await h.worker(1, 'small#1')
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('small#1 could not run t1 (ENOSPC) and no worker is left')
  } finally {
    await h.stop()
  }
}, 3_000)

// Main's macOS run, 2026-10-23: mac#1 let unsafe.shard-1's lease end,
// mac#2 had left, and the run failed rather than start another.
it('a task its only worker failed waits for the worker the run starts for it then', async () => {
  let h: Awaited<ReturnType<typeof harness>>
  h = await harness(new Map([node('t1')]), undefined, undefined, undefined, undefined, {
    faulted: () => h.o.spawned('small#2', { size: 'small', cpu: 1, memory: 100 }),
  })
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    // Its join sets small's join limit at twice it: one at once gave
    // small#2 a few ms, and a loaded CI box missed them (PR #4169).
    await Bun.sleep(1_000)
    const a = await h.worker(1, 'small#1')
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    const b = await h.worker(1, 'small#2')
    expect(await b.batches()).toEqual([['t1']])
    await b.finish('t1')
    expect((await t1).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
}, 5_000)

// A batch for a wide worker passed the relay's 1 MiB body limit and every
// task in it failed with `413 body over 1 MiB` (2026-10-22).
it('a batch past the relay’s body limit goes in parts', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    const a = await h.worker(3)
    await Bun.sleep(50)
    // Random, so it is past the limit compressed too.
    const env = {
      BIG: Buffer.from(crypto.getRandomValues(new Uint8Array(300_000))).toString('base64'),
    }
    for (const id of ['t1', 't2', 't3']) void h.o.execute({ ...h.req(id), env })
    const got: string[] = []
    for (let i = 0; i < 5 && got.length < 3; i++) got.push(...(await a.batches()).flat())
    expect(got.toSorted()).toEqual(['t1', 't2', 't3'])
  } finally {
    await h.stop()
  }
})

// A worker answering a cancel the run sent as it closed failed its CI job
// on the relay's `410 run closed` (2026-10-22).
it('a worker whose answer meets a closed run exits 0', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const raw = await join(url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save() {
          await Bun.sleep(100)
        },
        async output() {
          return null
        },
        async share() {
          return false
        },
        async resend() {
          return false
        },
        async restore() {
          return null
        },
      }),
    })
    const order = (task: string, command: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [],
      nested: [],
      command,
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    let sent = false
    for (let i = 0; i < 50 && !sent; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from !== 'relay' || m.type !== 'joined') continue
        await o.send(m.id!, {
          type: 'welcome',
          name: 'a',
          cache: { refs: [], lent: {} },
          cores: 1,
          memory: 1e9,
        })
        await o.send(m.id!, {
          type: 'batch',
          root,
          realRoot: root,
          tasks: [order('t1', 'sleep 2'), order('t2', 'true')],
        })
        await o.send(m.id!, { type: 'cancel', task: 't2' })
        sent = true
      }
    }
    await raw.leave()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// Main, 2026-10-23: workers booked 3.7 cores and used 2.4; a task held its
// cores while its outputs went up to the cache. The next begins once the
// command is done.
it('a worker begins its next task while the last one saves', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  let saved!: () => void
  const saving = new Promise<void>((r) => (saved = r))
  try {
    const raw = await join(url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save(_key, task) {
          if (task.id === 't1') await saving
        },
        async output() {
          return null
        },
        async share() {
          return false
        },
        async resend() {
          return false
        },
        async restore() {
          return null
        },
      }),
    })
    const order = (task: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [],
      nested: [],
      command: 'true',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    // Each `start` is sent unawaited, so the relay may hand them over in
    // either order, and t2 (`true`) may end in the same poll it starts.
    const seen: string[] = []
    const started = () => seen.includes('start t1') && seen.includes('start t2')
    for (let i = 0; i < 100 && !started(); i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string; task?: string }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 1,
            memory: 1e9,
          })
          await o.send(m.id!, {
            type: 'batch',
            root,
            realRoot: root,
            tasks: [order('t1'), order('t2')],
          })
        } else if (m.type === 'start' || m.type === 'end') seen.push(`${m.type} ${m.task}`)
      }
    }
    expect(started()).toBe(true)
    expect(seen).not.toContain('end t1')
    saved()
    await raw.leave()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// 2026-10-22: workers at 30-50% CPU; "close to 100%". A task books the
// cores it keeps busy on average, so a 4-core worker takes five at 0.7.
it('books the cores a task keeps busy on average, unrounded, a quarter at least', () => {
  expect(
    [0.7, 2.4, 0.01].map((c) => needOf({ p50DurationMs: 1, maxCpuParallelism: c }).cores),
  ).toEqual([0.7, 2.4, 0.25])
  expect(needOf(undefined)).toEqual({ cores: 1, memory: 0, ask: { cores: 2, memory: 4e9 } })
})

// Main cc5a276, 2026-10-23: check.bun, vx-docs#import and release.sync end
// before the Linux sandbox's first look, so none has a CPU measure; each
// booked a whole worker and small#1 ran at 13%. Wasted: "we can't waste whole
// worker for one task", "pack them where we have free capability".
it('places an unmeasured task on any free core, and sizes the run by 2 cores and 4GB or what is set', () => {
  const fresh = needOf({ p50DurationMs: 143 })
  expect(fresh).toEqual({ cores: 1, memory: 0, ask: { cores: 2, memory: 4e9 } })
  expect(needOf(undefined, { cores: 1, memory: 5 }).ask).toEqual({ cores: 1, memory: 5 })
  // A worker with 3 cores free takes all three: none waits for a new one.
  const busy = {
    id: 'w',
    cores: 4,
    memory: 16e9,
    used: { cores: 1, memory: 15e9 },
    running: 1,
    has: new Set<string>(),
    platform: undefined,
  }
  const to = assign(
    ['a', 'b', 'c'].map((id) => ({ id, need: fresh, up: [] })),
    [busy],
    undefined,
    'best-fit',
  )
  expect([...to.keys()].sort()).toEqual(['a', 'b', 'c'])
  // CONTROL: a task measured at 4 cores does not fit there.
  expect(
    assign([{ id: 'm', need: { cores: 4, memory: 1 }, up: [] }], [busy], undefined, 'best-fit')
      .size,
  ).toBe(0)
  // The plan counts each as its ask: two of them want 4 cores of workers.
  const node = (id: string) =>
    [id, { id, deps: [], config: { exec: { command: 'x' } } } as unknown as TaskNode] as const
  const work = planTasks(
    ['a', 'b'],
    new Map([node('a'), node('b')]),
    () => fresh,
    () => 100,
  )
  expect(work.map((t) => [t.cores, t.memory])).toEqual([
    [2, 4e9],
    [2, 4e9],
  ])
  expect(refusal(() => dte({ relay: 'https://r', unmeasured: { cpu: 0, memory: '1GB' } }))).toBe(
    'dte() option "unmeasured.cpu" must be a number above 0, got 0',
  )
  expect(refusal(() => dte({ relay: 'https://r', unmeasured: { cpu: 1, memory: 'lots' } }))).toBe(
    `dte() option "unmeasured.memory" must be bytes above 0 or a size such as '4GB', got "lots"`,
  )
})

it('reads memory as bytes or with a unit', () => {
  expect([
    bytes('8GB'),
    bytes('512MiB'),
    bytes(1024),
    bytes('1.5 gb'),
    bytes('8'),
    bytes(0),
    bytes('0GB'),
  ]).toEqual([8e9, 512 * 1024 ** 2, 1024, 1.5e9, undefined, undefined, undefined])
})

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

// Worded as vxCache() and vxHistory() word the same refusal; a value is never printed.
it('refuses a header it cannot send, never printing a value', () => {
  const relay = 'https://r'
  expect(refusal(() => dte({ relay, headers: { authorization: 'x' } }))).toBe(
    'dte() option "headers" cannot set "authorization"',
  )
  expect(refusal(() => dte({ relay, headers: { a: 'x\ny' } }))).toBe(
    'dte() option "headers.a" must be one line of text (its value is not printed)',
  )
  // A name the dial sets itself, in any case, was joined to its own value
  // (Bun's WebSocket sends "a, b"): a joined Relay-Proof proves nothing.
  // vxCache() refuses such names (226034b744).
  for (const name of ['Content-Type', 'Relay-Proof'])
    expect(refusal(() => dte({ relay, headers: { [name]: 'x' } }))).toBe(
      `dte() option "headers" cannot set "${name}"`,
    )
})

it('refuses options it does not read and workers it cannot start', () => {
  const adapter = local()
  const W = { s: { cpu: 1, memory: '1GB' } }
  expect(refusal(() => dte({ workers: W, adapter, relays: 'x' } as never))).toContain(
    'dte() has unknown option "relays"',
  )
  // Each names the field and the value it got: one line for three fields named none.
  expect(refusal(() => dte({ workers: { s: { max: 1, cpu: 0, memory: '1GB' } }, adapter }))).toBe(
    'dte() option "workers.s.cpu" must be a whole number ≥ 1, got 0',
  )
  expect(
    refusal(() => dte({ workers: { s: { max: 1, cpu: 1, memory: '8 lots' } }, adapter })),
  ).toBe(
    `dte() option "workers.s.memory" must be bytes above 0 or a size such as '8GB', got "8 lots"`,
  )
  expect(refusal(() => dte({ workers: { s: { max: 1.5, cpu: 1, memory: '1GB' } }, adapter }))).toBe(
    'dte() option "workers.s.max" must be a whole number ≥ 0, got 1.5',
  )
  expect(
    refusal(() =>
      dte({ workers: { s: { cpu: 1, memory: '1GB', platform: 'win32-x64' as never } }, adapter }),
    ),
  ).toBe(
    'dte() option "workers.s.platform" must be one of linux-x64, linux-arm64, darwin-x64, darwin-arm64, got "win32-x64"',
  )
  // A size's typo was read as nothing: `maxx: 2` started workers uncapped.
  expect(
    refusal(() => dte({ workers: { s: { maxx: 2, cpu: 1, memory: '1GB' } as never }, adapter })),
  ).toBe(
    'dte() option "workers.s" has unknown option "maxx" (allowed: cpu, max, memory, platform) — did you mean max?',
  )
  expect(
    refusal(() =>
      dte({ relay: 'https://r', unmeasured: { cpu: 1, memory: '1GB', mem: 1 } as never }),
    ),
  ).toContain('dte() option "unmeasured" has unknown option "mem"')
  expect(
    refusal(() =>
      dte({
        workers: { s: { max: 1, cpu: 1, memory: '1GB', platform: undefined } as never },
        adapter,
      }),
    ),
  ).toBe('taken')
  expect(refusal(() => dte({ workers: W, adapter, scheduler: { order: 'lifo' } as never }))).toBe(
    'dte() option "scheduler.order" must be one of critical-path, graphene, fifo, got "lifo"',
  )
  expect(refusal(() => dte({ workers: W, adapter, scheduler: { pace: 'x' } as never }))).toBe(
    'dte() option "scheduler" has no layer "pace" (layers: order, place, book, scale)',
  )
  expect(refusal(() => dte({}))).toBe(
    'dte(): with no adapter, set relay: the workers that join it run the tasks',
  )
  // A .mjs config's bare `dte()` read `options.headers` and threw a TypeError.
  expect(refusal(() => (dte as (o?: unknown) => unknown)())).toBe(
    'dte(): with no adapter, set relay: the workers that join it run the tasks',
  )
  expect(refusal(() => dte({ relay: 'http://relay.test' }))).toBe('taken')
  expect(refusal(() => dte({ workers: { s: { cpu: 2, memory: '8GB' } }, adapter }))).toBe('taken')
  expect(refusal(() => local({ prepar: 'x' } as never))).toContain(
    'local() has unknown option "prepar"',
  )
  // An adapter with no size it may start ran nothing, and the run waited until killed.
  const none =
    "dte(): workers names no size the adapter may start (one with max above 0), such as small: { cpu: 2, memory: '8GB' }"
  expect(refusal(() => dte({ workers: {}, adapter }))).toBe(none)
  expect(refusal(() => dte({ adapter }))).toBe(none)
  expect(refusal(() => dte({ workers: { s: { max: 0, cpu: 1, memory: '1GB' } }, adapter }))).toBe(
    none,
  )
  expect(refusal(() => docker({} as never))).toBe(
    "docker() needs image: one with Bun and git, such as 'oven/bun:1.4' plus git",
  )
  // A plain Error printed a stack under VX_E_INTERNAL (2026-10-28).
  expect(() => docker({} as never)).toThrow(UserError)
})

// A run from a git hook inherits the hook's GIT_INDEX_FILE / GIT_DIR. The
// worktree add then wrote the new tree's index over the one being
// committed (the staged change was gone), and every worker in its own
// worktree read the hook's index and repository, not its own.
// A hook in the main worktree sets a relative GIT_INDEX_FILE alone; one in
// a linked worktree sets both, absolute.
for (const hook of ['main', 'linked'] as const)
  it(`local() makes its worktrees and workers under no git hook index or repository (${hook} worktree hook)`, async () => {
    const repo = await realpath(await tmp())
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        env: { ...process.env, GIT_INDEX_FILE: undefined, GIT_DIR: undefined },
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    git('init', '-q')
    git('config', 'user.email', 't@vx.local')
    git('config', 'user.name', 't')
    await writeFile(path.join(repo, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '-qm', 'init')
    await writeFile(path.join(repo, 'staged.txt'), 's')
    git('add', 'staged.txt')
    const commit = git('rev-parse', 'HEAD')
    const seen = path.join(await tmp(), 'env.txt')
    const saved = { index: process.env['GIT_INDEX_FILE'], dir: process.env['GIT_DIR'] }
    if (hook === 'main') process.env['GIT_INDEX_FILE'] = '.git/index'
    else {
      process.env['GIT_INDEX_FILE'] = path.join(repo, '.git', 'index')
      process.env['GIT_DIR'] = path.join(repo, '.git')
    }
    // The prepare records the worker's env and fails, so no worker starts.
    const adapter = local({ prepare: `env > ${JSON.stringify(seen)}; exit 1` })
    let failed = ''
    try {
      await adapter.spawn({
        run: R,
        relay: 'http://127.0.0.1:9',
        size: 's',
        max: 1,
        cpu: 1,
        memory: 1e9,
        index: 1,
        id: 's#1',
        workspaceRoot: repo,
        commit,
        env: {},
        exited: () => {},
      })
    } catch (err) {
      failed = (err as Error).message
    } finally {
      if (saved.index === undefined) delete process.env['GIT_INDEX_FILE']
      else process.env['GIT_INDEX_FILE'] = saved.index
      if (saved.dir === undefined) delete process.env['GIT_DIR']
      else process.env['GIT_DIR'] = saved.dir
      await adapter.close?.()
    }
    expect(failed).toStartWith('prepare exited 1')
    expect(git('diff', '--cached', '--name-only')).toBe('staged.txt')
    const env = await readFile(seen, 'utf8')
    expect(env).not.toMatch(/^GIT_(INDEX_FILE|DIR)=/m)
  }, 20_000)

it('a worker size or unmeasured with a key dte() does not read is refused', () => {
  // A typo of max left the size uncapped, without a word.
  const adapter = local()
  expect(
    refusal(() => dte({ workers: { s: { cpu: 1, memory: '1GB', maxx: 2 } as never }, adapter })),
  ).toBe(
    'dte() option "workers.s" has unknown option "maxx" (allowed: cpu, max, memory, platform) — did you mean max?',
  )
  expect(
    refusal(() =>
      dte({ relay: 'https://r', unmeasured: { cpu: 1, memory: '1GB', cpus: 2 } as never }),
    ),
  ).toBe(
    'dte() option "unmeasured" has unknown option "cpus" (allowed: cpu, memory) — did you mean cpu?',
  )
})

it('docker() with no options says what it needs, as a user error', () => {
  // A bare docker() threw a TypeError reading options.image: a crash, not a setting to fix.
  for (const options of [undefined, {}, { image: '' }]) {
    let err: unknown
    try {
      docker(options as never)
    } catch (e) {
      err = e
    }
    expect([isUserError(err), (err as Error).message]).toEqual([
      true,
      "docker() needs image: one with Bun and git, such as 'oven/bun:1.4' plus git",
    ])
  }
})

it('a run that is not distributed loads none of it', async () => {
  // Every run evaluates `.vx/workspace.ts`: importing the plugin may not
  // load the orchestrator, the worker or the relay.
  const probe = `
const seen = []
Bun.plugin({ name: 'seen', setup(b) {
  b.onLoad({ filter: /(vx-dte|vx-dte-server)\\/src\\/[^/]+\\.ts$/ }, async (a) => {
    seen.push(a.path.split('/').slice(-3).join('/'))
    return { contents: await Bun.file(a.path).text(), loader: 'ts' }
  })
} })
const m = await import(process.argv[1])
m.dte({ workers: { s: { cpu: 1, memory: '1GB' } }, adapter: m.local() })
console.log(JSON.stringify(seen.sort()))
`
  const p = Bun.spawnSync([
    process.execPath,
    '-e',
    probe,
    path.join(import.meta.dir, '..', 'src', 'index.ts'),
  ])
  expect(JSON.parse(p.stdout.toString())).toEqual([
    'vx-dte/src/docker.ts',
    'vx-dte/src/github.ts',
    'vx-dte/src/gitlab.ts',
    'vx-dte/src/index.ts',
    'vx-dte/src/local.ts',
    'vx-dte/src/plugin.ts',
    'vx-dte/src/printable.ts',
    'vx-dte/src/strategy.ts',
  ])
})

it('docker() starts each worker as a container of its size, on a fresh clone', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: ws })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'i')
  const sha = git('rev-parse', 'HEAD').stdout.toString().trim()
  await mkdir(path.join(ws, 'sub'))
  // The root through a link, as macOS's /tmp is: git names the real path,
  // and the worker's `cd` climbed out of the clone (a developer Mac, 2026-10-21).
  const link = path.join(await tmp(), 'ws')
  await symlink(ws, link)
  const bin = await tmp()
  const argv = path.join(bin, 'argv')
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\0' "$@" > ${argv}\n`, {
    mode: 0o755,
  })
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  // docker() mounts ~/.vx: a home of its own, not the real one.
  const home = process.env['HOME']
  process.env['HOME'] = await tmp()
  // As root: as another user a Linux container is told who it is.
  const uid = process.getuid!
  process.getuid = () => 0
  try {
    const d = docker({ image: 'img', prepare: 'bun install' })
    await d.spawn({
      run: R,
      relay: 'http://127.0.0.1:9',
      size: 'small',
      max: 1,
      cpu: 2,
      memory: 8e9,
      index: 3,
      id: 'small#3',
      workspaceRoot: path.join(link, 'sub'),
      commit: sha,
      env: { VX_DTE_RUN: R, VX_DTE_WORKER: 'small#3', VX_DTE_RELAY: 'http://127.0.0.1:9' },
      exited: () => {},
    })
    for (let i = 0; i < 100 && !(await Bun.file(argv).exists()); i++) await Bun.sleep(20)
    const args = (await readFile(argv, 'utf8')).split('\0').slice(0, -1)
    const script = args.at(-1)!
    expect(args.slice(0, 8)).toEqual([
      'run',
      '--rm',
      '--name',
      `vx-dte-${process.pid}-3`,
      '--cpus',
      '2',
      '--memory',
      '8000000000b',
    ])
    expect(args).toContain(`${await realpath(ws)}:/src:ro`)
    expect(args.slice(-4, -2)).toEqual(['img', 'sh'])
    expect(script).toBe(
      [
        'set -e',
        'git clone -q /src /work',
        'cd /work',
        'git remote remove origin',
        `git fetch -q --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' /src ${sha}`,
        `git checkout -q --detach ${sha}`,
        "cd 'sub'",
        '{',
        'bun install',
        '} >&2',
        'exec ./node_modules/.bin/vx dte worker',
      ].join('\n'),
    )
    await d.close?.()
  } finally {
    process.env['PATH'] = saved
    process.env['HOME'] = home
    process.getuid = uid
  }
})

it('a machine’s usage: peaks of tasks at once, averages over its time online', () => {
  const u = new Usage(0)
  const at = (end: number, durationMs: number, cpuMs: number, peakRssBytes: number) => {
    const now = performance.now
    performance.now = () => end
    try {
      u.record({ exitCode: 0, durationMs, cpuMs, peakRssBytes })
    } finally {
      performance.now = now
    }
  }
  // Two tasks overlap from 500 to 1000; a third starts as the first ends.
  at(1000, 1000, 1000, 100)
  at(1500, 1000, 2000, 200)
  at(2000, 1000, 1000, 50)
  u.failed = 1
  expect(u.stats(4, 4000)).toEqual({
    onlineMs: 4000,
    busyMs: 2000,
    cpuPeak: 3,
    cpuAvg: 1,
    memoryPeak: 300,
    memoryAvg: 87.5,
    utilization: 0.25,
    cpuMs: 4000,
    bookedAvg: 0,
  })
})

// A worker restoring and saving between commands read 10 s idle on main
// (2026-10-24): a task holds it from its send to its result.
it('a machine’s busy time: each task from its send, restore and save included', () => {
  const u = new Usage(0)
  const now = performance.now
  try {
    performance.now = () => 5000
    // Sent at 1000, its command 1 s of it: the rest restored and saved.
    u.record({ exitCode: 0, durationMs: 1000, cpuMs: 2000 }, 1000)
    performance.now = () => 9000
    u.record({ exitCode: 0, durationMs: 1000, cpuMs: 2000 }, 5000)
  } finally {
    performance.now = now
  }
  const st = u.stats(4, 10_000)
  expect(st.busyMs).toBe(8000)
  expect(st.cpuMs).toBe(4000)
})

// Main ran 12 workers at 25% with each busy all its time online: what the
// run held on each says whether packing or the tasks left the cores idle.
it('a machine’s booked cores: what the run held for its tasks, averaged over its time online', () => {
  const u = new Usage(0)
  u.book(4, 0)
  u.book(-4, 1000)
  u.book(1, 1000)
  u.book(1, 2000)
  // Still held when the run ends at 4000: 4 + 1 + 2 * 2 core-seconds.
  expect(u.stats(4, 4000).bookedAvg).toBe(2.25)
})

// A Ctrl-C read `0 done · 2 failed` for one failed and one stopped task.
it('counts a task the stop killed as aborted, a timeout as failed', () => {
  const u = new Usage(0)
  u.record({ exitCode: 0, durationMs: 1 })
  u.record({ exitCode: 2, durationMs: 1 })
  u.record({ exitCode: 130, signal: 'SIGTERM', durationMs: 1 })
  u.record({ exitCode: 143, signal: 'SIGTERM', timedOut: true, durationMs: 1 })
  expect([u.done, u.failed, u.aborted]).toEqual([1, 2, 1])
})

// The share a worker reports: its cores over the threads Linux has
// runnable, less the one reading /proc/stat.
it('reads how crowded the CPU is from the run queue', async () => {
  const stat = (n: number) => `cpu  1 2 3\nprocs_running ${n}\nprocs_blocked 0\n`
  expect(crowdShare(stat(13), 4)).toBeCloseTo(4 / 12, 5)
  expect(crowdShare(stat(3), 4)).toBe(1)
  expect(crowdShare('cpu 1 2 3\n', 4)).toBeUndefined()
  let running = 3
  const os = await import('node:os')
  const cores = os.cpus().length
  const meter = loadMeter(() => stat(running))
  try {
    const from = meter.mark()
    await Bun.sleep(450)
    running = cores * 3 + 1
    const crowded = meter.mark()
    await Bun.sleep(450)
    expect(meter.shareSince(crowded)).toBeCloseTo(1 / 3, 2)
    const both = meter.shareSince(from)!
    expect(both).toBeGreaterThan(1 / 3)
    expect(both).toBeLessThan(1)
    // No look since: no correction.
    expect(meter.shareSince(meter.mark())).toBeUndefined()
  } finally {
    meter.stop()
  }
  // No /proc/stat (macOS): the load average says it, while every core is busy.
  let ticks = 0
  const full = (): [number, number] => [(ticks += 100), ticks]
  const mac = loadMeter(
    () => undefined,
    () => cores * 2,
    full,
  )
  try {
    const from = mac.mark()
    await Bun.sleep(450)
    expect(mac.shareSince(from)).toBeCloseTo(1 / 2, 2)
  } finally {
    mac.stop()
  }
  // Main 8fa3c98: a macOS runner's load average read 49 with a core idle,
  // and each shard was learned to need the whole machine. Not crowded.
  let spare = 0
  const idle = (): [number, number] => [(spare += 50), spare * 2]
  const roomy = loadMeter(
    () => undefined,
    () => cores * 16,
    idle,
  )
  try {
    const from = roomy.mark()
    await Bun.sleep(450)
    expect(roomy.shareSince(from)).toBe(1)
  } finally {
    roomy.stop()
  }
  // Main 3917881: six shards used 2.3 of a Mac's 3 cores and read a share
  // of 0.22; each wanted at most what it used and the cores left free.
  let busy = 0
  const nine = (): [number, number] => [(busy += 90), (busy / 90) * 100]
  const free = loadMeter(
    () => undefined,
    () => cores * 5,
    nine,
  )
  try {
    const from = free.mark()
    await Bun.sleep(450)
    expect(free.shareSince(from)).toBeCloseTo(0.2, 2)
    expect(free.shareSince(from, 0.4)).toBeCloseTo(0.4 / (0.4 + 0.1 * cores), 2)
  } finally {
    free.stop()
  }
  // Neither (Windows): no correction.
  const none = loadMeter(
    () => undefined,
    () => 0,
  )
  try {
    const from = none.mark()
    await Bun.sleep(250)
    expect(none.shareSince(from)).toBeUndefined()
  } finally {
    none.stop()
  }
})

// #4313's run: a worker's frames were too few to average `cpu` by; each
// frame says the machine's average since the worker started.
it('says the machine’s busy cores on average since the meter started', async () => {
  const cores = (await import('node:os')).cpus().length
  // Half the CPUs' time busy at each read after the first.
  let t = 0
  const half = (): [number, number] => [(t += 50), t * 2]
  const meter = loadMeter(
    () => undefined,
    () => 0,
    half,
  )
  try {
    expect(meter.now().avg).toBeCloseTo(cores / 2, 2)
  } finally {
    meter.stop()
  }
})

// Main c27c238 (2026-10-23): on a crowded worker a task uses its share of
// the CPU, not its need. Booking the next tasks by what it used packed
// them tighter, which crowded the worker more: 9 shards on 4 cores.
it('learns from what a crowded task would have used, and keeps its share for the history', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const w = await h.worker(4)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await w.batches()).toEqual([['t1']])
    await w.finish('t1', 'k-t1', {
      exitCode: 0,
      durationMs: 60_000,
      cpuMs: 21_600,
      cpuShare: 0.36,
    })
    expect(await t1).toMatchObject({ machine: { cores: 4, cpuShare: 0.36 } })
    // It used 0.36 of a core, the share it got of 1: its whole need.
    expect(h.o.booking({ cores: 1, memory: 10 }).cores).toBe(1)
  } finally {
    await h.stop()
  }
})

it('knows how long a worker took to join', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    expect(h.o.warmUpMs()).toBeUndefined()
    // One that joined on its own was never asked for: it says nothing.
    await h.worker(2)
    h.o.spawned('small#1', { size: 'small', cpu: 2, memory: 100 })
    await Bun.sleep(120)
    await h.worker(2, 'small#1')
    await Bun.sleep(50)
    expect(h.o.warmUpMs()).toBeGreaterThanOrEqual(100)
    // By the size it was asked as; the one that joined on its own has none.
    expect([...h.o.warmUpsMs().keys()]).toEqual(['small'])
    expect(h.o.warmUpsMs().get('small')).toBe(h.o.warmUpMs()!)
  } finally {
    await h.stop()
  }
})

it('gives an unmeasured task a whole worker, and one that filled its worker a bigger one', async () => {
  const whole = { cores: Infinity, memory: Infinity }
  const h = await harness(new Map([node('u1'), node('u2'), node('heavy')]), (id) =>
    id === 'heavy' ? { ...whole, above: { cores: 2, memory: 100 } } : whole,
  )
  try {
    const small = await h.worker(2)
    await Bun.sleep(50)
    // No history: alone on its worker.
    const u1 = h.o.execute(h.req('u1'))
    void h.o.execute(h.req('u2'))
    expect(await small.batches()).toEqual([['u1']])
    await small.finish('u1')
    // The run keeps where it ran and that machine's size, for the next run.
    expect(await u1).toMatchObject({ where: 'worker#1', machine: { cores: 2, memoryBytes: 100 } })
    expect(await small.batches()).toEqual([['u2']])
    await small.finish('u2')
    // It filled a 2-core worker: the idle one is passed over for the
    // bigger one starting.
    h.o.spawned('big#2', { size: 'big', cpu: 8, memory: 1000 })
    void h.o.execute(h.req('heavy'))
    await Bun.sleep(50)
    const big = await h.worker(8)
    expect(await big.batches()).toEqual([['heavy']])
  } finally {
    await h.stop()
  }
}, 30_000)

// A bigger worker of another platform cannot take it: a Mac task that
// filled its Mac waited for a Linux worker to join, and then ran on the Mac.
it('a task that filled its worker waits for no bigger one of another platform', async () => {
  const h = await harness(new Map([node('heavy')]), () => ({
    cores: Infinity,
    memory: Infinity,
    above: { cores: 2, memory: 100 },
  }))
  try {
    const mac = await h.worker(2, undefined, 'darwin-arm64')
    h.o.spawned('big#1', { size: 'big', cpu: 8, memory: 1000, platform: 'linux-x64' })
    await Bun.sleep(50)
    void h.o.execute({ ...h.req('heavy'), platform: 'darwin-arm64' })
    const sent = await Promise.race([mac.batches(), Bun.sleep(2_000).then(() => 'none')])
    expect(sent).toEqual([['heavy']])
  } finally {
    await h.stop()
  }
}, 30_000)

it('a worker’s reason is its error line, not the hint after it', () => {
  expect([
    errorLine("\u001b[31m✗\u001b[0m vx  'dte' is not a vx command\n  fix  vx run dev --all\n"),
    errorLine('resolving\nerror: cannot find module\n  at x\n'),
    errorLine('just this\n\n'),
    errorLine(''),
    // git's own, from a container's clone (2026-10-21).
    errorLine(
      "warning: templates not found\nfatal: detected dubious ownership in repository at '/src/.git'\nTo add an exception...\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
    ),
  ]).toEqual([
    "✗ vx  'dte' is not a vx command",
    'error: cannot find module',
    'just this',
    '',
    "fatal: detected dubious ownership in repository at '/src/.git'",
  ])
})

// Main's workers booked 4.3 of 4 cores (2026-10-23): a task began on a
// free core whatever it asked. Beside others it fits in full or waits;
// an empty worker takes anything, alone.
it('a task begins beside others only when its cores and memory fit in full', () => {
  const bin = (cores: number, memory: number, running = 1) => ({
    id: 'w',
    cores: 4,
    memory: 16e9,
    used: { cores, memory },
    running,
  })
  expect(fits(bin(2.5, 1e9), { cores: 1.5, memory: 1e9 })).toBe(true)
  expect(fits(bin(3.2, 1e9), { cores: 1.5, memory: 1e9 })).toBe(false)
  expect(fits(bin(1, 15e9), { cores: 1, memory: 2e9 })).toBe(false)
  expect(fits(bin(0.5, 0), { cores: 4, memory: 0 })).toBe(false)
  expect(fits(bin(0, 0, 0), { cores: Infinity, memory: Infinity })).toBe(true)
})

// Main fd9afe0: a Mac's tasks' exits said 1.8 cores and they ran at half
// their share; the machine's busy cores beside its tasks' trees say where.
it('reads each running task’s process tree every look: the cores its tree used since the last', async () => {
  let cpu = 0
  const trees = treeMeter(async (roots) => {
    cpu += 30
    return new Map(roots.map((r) => [r, { cpuMs: r === 7 ? cpu : 0, rssBytes: 0 }]))
  }, 20)
  try {
    trees.watch('t1', 7)
    trees.watch('t2', 8)
    await Bun.sleep(130)
    // 30 ms of CPU each 20 ms look: about one and a half cores, all t1's.
    expect(trees.now()).toBeGreaterThan(0.5)
    trees.drop('t1')
    expect(trees.now()).toBe(0)
  } finally {
    trees.stop()
  }
})

// Workers run the run's tree: a key that folds an untracked file was
// saved from a run without it, a stale hit for the next run here
// (2026-10-24, untracked a/src/z: the hit replayed the output that lacked it).
it('fails a task whose key folds a file the run’s tree lacks, naming it', async () => {
  const root = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', ...a], { cwd: root })
      .stdout.toString()
      .trim()
  git('init', '-q')
  await mkdir(path.join(root, 'a/src'), { recursive: true })
  await writeFile(path.join(root, 'a/src/x'), 'x\n')
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'i')
  await writeFile(path.join(root, 'a/src/z'), 'z\n')
  const served = servedRelay()
  try {
    const o = new Orchestrator({
      me: await join(served.url, R, 'orchestrator', null, undefined),
      root,
      tree: git('rev-parse', 'HEAD^{tree}'),
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
    })
    const req = (taskId: string, ...paths: string[]) =>
      ({
        taskId,
        inputs: { files: paths.map((p) => ({ path: p, digest: 'd' })) },
      }) as unknown as ExecuteRequest
    await expect(o.execute(req('a#build', 'a/src/x', 'a/src/z'))).rejects.toThrow(
      "a#build keys a/src/z, which is not in the commit workers check out: commit it, or leave it out of the task's inputs",
    )
    await o.close()
  } finally {
    await served.stop()
  }
})

// One `end` holds what the task left: a formatter's 24 000 changed files
// (or a sandbox's 9000 violations) made it over the relay's 1 MiB frame,
// and the run waited for an `end` that never came (2026-10-25).
it('sends a result too long for one relay frame in parts, all of it arriving', async () => {
  const root = await tmp()
  const many = 24_000
  await mkdir(path.join(root, 'files'))
  await Promise.all(
    Array.from({ length: many }, (_, i) =>
      writeFile(path.join(root, 'files', `a-rather-long-file-name-${i}.txt`), '0\n'),
    ),
  )
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => fakeArtifacts().artifacts,
    })
    const order: RunOrder = {
      task: 'fmt',
      key: 'k-fmt',
      runKey: runKey(R, 'fmt'),
      deps: [],
      nested: [],
      command: "find files -type f -print0 | xargs -0 sed -i 's/0/1/'",
      cwd: '',
      project: '',
      env: { PATH: process.env['PATH'] ?? '' },
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    const changed: string[] = []
    let ended = false
    for (let i = 0; i < 400 && !ended; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          changed?: string[]
          result?: { changed?: string[] }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'part') {
          changed.push(...(m.changed ?? []))
        } else if (m.type === 'end') {
          changed.push(...(m.result?.changed ?? []))
          ended = true
          await o.send(from, { type: 'exit' })
        }
      }
    expect(ended).toBe(true)
    expect(changed).toHaveLength(many)
    expect(await code).toBe(0)
  } finally {
    await served.stop()
    // Here, under the test's minute: 24 000 files outlast the 5 s hook
    // below on a loaded runner, which failed the test after it passed.
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

// Parts were cut by UTF-16 length, not bytes: a part of CJK output
// sealed past the relay's 1 MiB and its result never arrived (2026-10-25).
it('sends a long non-ASCII output in parts the relay takes', async () => {
  const root = await tmp()
  await writeFile(path.join(root, 'log.txt'), '漢字の出力です。'.repeat(80_000))
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      // Shared with no remote: its output goes with its `end`.
      artifacts: () => ({ ...fakeArtifacts().artifacts, uploaded: async () => false }),
    })
    const order: RunOrder = {
      task: 'log',
      runKey: runKey(R, 'log'),
      deps: [],
      nested: [],
      command: 'cat log.txt',
      cwd: '',
      project: '',
      env: { PATH: process.env['PATH'] ?? '' },
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    let text = ''
    let ended = false
    for (let i = 0; i < 400 && !ended; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          output?: { text: string }[]
          result?: { output?: { text: string }[] }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'part') {
          text += (m.output ?? []).map((c) => c.text).join('')
        } else if (m.type === 'end') {
          text += (m.result?.output ?? []).map((c) => c.text).join('')
          ended = true
          await o.send(from, { type: 'exit' })
        }
      }
    expect(ended).toBe(true)
    expect(text).toHaveLength(640_000)
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
}, 60_000)

// Output cut every 32 768 UTF-16 units split an emoji's surrogate pair:
// each half replayed alone printed as two replacement characters (2026-10-25).
it('cuts a long output between characters, never inside one', async () => {
  const root = await tmp()
  await writeFile(path.join(root, 'log.txt'), `x${'😀'.repeat(40_000)}`)
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  const served = servedRelay()
  try {
    const o = sealOrchestrator(
      await join(served.url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      // Shared with no remote: its output goes with its `end`.
      artifacts: () => ({ ...fakeArtifacts().artifacts, uploaded: async () => false }),
    })
    const order: RunOrder = {
      task: 'log',
      runKey: runKey(R, 'log'),
      deps: [],
      nested: [],
      command: 'cat log.txt',
      cwd: '',
      project: '',
      env: { PATH: process.env['PATH'] ?? '' },
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    let text = ''
    const chunks: string[] = []
    let ended = false
    for (let i = 0; i < 400 && !ended; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          output?: { text: string }[]
          result?: { output?: { text: string }[] }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'part') {
          for (const c of m.output ?? []) chunks.push(c.text)
        } else if (m.type === 'end') {
          for (const c of m.result?.output ?? []) chunks.push(c.text)
          ended = true
          await o.send(from, { type: 'exit' })
        }
      }
    expect(ended).toBe(true)
    text = chunks.join('')
    expect(text).toHaveLength(80_001)
    expect(chunks.length).toBeGreaterThan(1)
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(chunks.filter((c) => lone.test(c))).toEqual([])
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
}, 60_000)

it('takes a result’s parts ahead of its end as one result', async () => {
  const h = await harness(new Map([node('t')]))
  try {
    const a = await h.worker(1)
    const ran = h.o.execute(h.req('t', 'k-t'))
    expect(await a.batches()).toEqual([['t']])
    const at = new Date(0).toISOString()
    await a.say({
      type: 'part',
      task: 't',
      changed: ['a/1'],
      violations: [{ line: 'v1', timestamp: at }],
    })
    await a.say({ type: 'part', task: 't', changed: ['a/2'] })
    await a.finish('t', 'k-t', {
      exitCode: 0,
      durationMs: 1,
      changed: ['a/3'],
      violations: [{ line: 'v2', timestamp: at }],
    })
    const res = await ran
    expect(res.changed).toEqual(['a/1', 'a/2', 'a/3'])
    expect(res.violations.map((v) => v.line)).toEqual(['v1', 'v2'])
  } finally {
    await h.stop()
  }
})

// A workspace in a repository subdirectory: git named the file from the
// repository's root, which matched no keyed file, and core saved a task's
// rewrite of its own input under its key (2026-10-25).
it('names a tracked file a task changed as the workspace does, in a repository subdirectory', async () => {
  const repo = await tmp()
  const ws = path.join(repo, 'ws')
  await mkdir(path.join(ws, 'a/gen'), { recursive: true })
  await writeFile(path.join(ws, 'a/in.txt'), '1\n')
  await writeFile(path.join(ws, 'a/gen/g.txt'), '1\n')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: repo })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  await writeFile(path.join(ws, 'a/in.txt'), '2\n')
  await writeFile(path.join(ws, 'a/gen/g.txt'), '2\n')
  const outputs = { files: ['gen/**'], workspaceFiles: [] }
  const m = { project: 'a', nested: [], outputs } as unknown as RunOrder
  expect(await changedTracked(ws, 'HEAD', m, names('a', outputs))).toEqual(['a/in.txt'])
})

// A worker clears what an earlier task left under a task's outputs, but
// never a tracked file. A git that could not list them (a corrupt index)
// read as none tracked, and committed files under `gen/**` were deleted.
it('refuses a checkout whose tracked files git cannot list', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(
      [
        'git',
        '-c',
        'user.email=t@vx.local',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...a,
      ],
      { cwd: ws },
    )
  await mkdir(path.join(ws, 'a/gen'), { recursive: true })
  await writeFile(path.join(ws, 'a/gen/g.txt'), '1\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  expect(trackedFiles(ws)).toEqual(new Set(['a/gen/g.txt']))
  await writeFile(path.join(ws, '.git/index'), 'not an index')
  expect(() => trackedFiles(ws)).toThrow(/git ls-files/)
  // Outside git nothing is tracked.
  expect(trackedFiles(await tmp())).toEqual(new Set())
})

// A pathspec is a glob unless told otherwise: a project at `p*` named its
// sibling `pa`'s changed files as its own, and its entry was withheld.
it('names only the tracked files under a project whose directory has glob characters', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(
      [
        'git',
        '-c',
        'user.email=t@vx.local',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...a,
      ],
      { cwd: ws },
    )
  for (const d of ['p*', 'pa']) {
    await mkdir(path.join(ws, d), { recursive: true })
    await writeFile(path.join(ws, d, 'in.txt'), '1\n')
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  await writeFile(path.join(ws, 'pa/in.txt'), '2\n')
  const outputs = { files: [], workspaceFiles: [] }
  const m = { project: 'p*', nested: [], outputs } as unknown as RunOrder
  expect(await changedTracked(ws, 'HEAD', m, names('p*', outputs))).toEqual([])
})

// git quotes a path with a quote, a non-ASCII byte or a newline unless
// asked for NUL-separated names: `"a/\303\251.ts"` started with no
// project's directory, and the forecast missed the task it changed.
it('names a changed path as it is, whatever bytes it holds', async () => {
  const ws = await tmp()
  await mkdir(path.join(ws, 'a'), { recursive: true })
  const git = (...a: string[]) =>
    Bun.spawnSync(
      [
        'git',
        '-c',
        'user.email=t@vx.local',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...a,
      ],
      { cwd: ws },
    )
  git('init', '-q')
  await writeFile(path.join(ws, 'a/x.ts'), '1\n')
  git('add', '-A')
  git('commit', '-qm', 'i')
  const odd = ['a/é.ts', 'a/q"uote.ts', 'a/new\nline.ts']
  for (const f of odd) await writeFile(path.join(ws, f), '1\n')
  git('add', '-A')
  git('commit', '-qm', 'ii')
  expect((await changedSinceParent(ws)).toSorted()).toEqual(odd.toSorted())
})

// `git stash create` writes a commit, and git refuses one with no identity
// (a CI runner with none configured): the snapshot fell back to HEAD, and
// the run's workers checked out a tree without its uncommitted changes.
it('snapshots the uncommitted changes in a checkout with no git identity', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...a], { cwd: ws })
      .stdout.toString()
      .trim()
  git('init', '-q')
  await writeFile(path.join(ws, 'f.txt'), '1\n')
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'i')
  git('config', 'user.name', '')
  git('config', 'user.email', '')
  await writeFile(path.join(ws, 'f.txt'), '2\n')
  const { tree } = await snapshot(ws)
  expect(tree).not.toBe('')
  expect(git('rev-parse', `${tree}:f.txt`)).toBe(git('hash-object', 'f.txt'))
})

// `git stash create` cannot save a tree holding an intent-to-add entry
// (`git add -N`): the snapshot fell back to HEAD, without the changes.
it('snapshots every tracked file as it is on disk, deletions, modes and intent-to-add too', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(
      [
        'git',
        '-c',
        'user.email=t@vx.local',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...a,
      ],
      { cwd: ws },
    )
      .stdout.toString()
      .trim()
  git('init', '-q')
  for (const f of ['gone.txt', 'mode.sh', 'mod.txt']) await writeFile(path.join(ws, f), '1\n')
  await symlink('mod.txt', path.join(ws, 'link'))
  git('add', '-A')
  git('commit', '-qm', 'i')
  await rm(path.join(ws, 'gone.txt'))
  await chmod(path.join(ws, 'mode.sh'), 0o755)
  await writeFile(path.join(ws, 'mod.txt'), '2\n')
  await rm(path.join(ws, 'link'))
  await symlink('mode.sh', path.join(ws, 'link'))
  await writeFile(path.join(ws, 'new.txt'), 'new\n')
  git('add', '-N', 'new.txt')
  await writeFile(path.join(ws, 'untracked.txt'), 'u\n')
  const { commit, tree } = await snapshot(ws)
  expect(git('rev-parse', `${commit}^{tree}`)).toBe(tree)
  expect(git('ls-tree', '-r', tree).replace(/ [0-9a-f]{40}/g, '')).toBe(
    [
      '120000 blob\tlink',
      '100644 blob\tmod.txt',
      '100755 blob\tmode.sh',
      '100644 blob\tnew.txt',
    ].join('\n'),
  )
  for (const f of ['mod.txt', 'mode.sh', 'new.txt'])
    expect(git('rev-parse', `${tree}:${f}`)).toBe(git('hash-object', f))
  expect(git('cat-file', 'blob', `${tree}:link`)).toBe('mode.sh')
  // The index and the working tree are as they were.
  expect(git('status', '--porcelain')).toBe(
    ['D gone.txt', ' M link', ' M mod.txt', ' M mode.sh', ' A new.txt', '?? untracked.txt'].join(
      '\n',
    ),
  )
})

// A git that failed answered "nothing changed", and the task's rewrite of
// a tracked file was saved under its clean key.
it('a diff git cannot answer names the project as changed, never nothing', async () => {
  const ws = await tmp()
  await mkdir(path.join(ws, 'a'), { recursive: true })
  await writeFile(path.join(ws, 'a/in.txt'), '1\n')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: ws })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i')
  const outputs = { files: [], workspaceFiles: [] }
  const m = { project: 'a', nested: [], outputs } as unknown as RunOrder
  expect(await changedTracked(ws, 'HEAD', m, names('a', outputs))).toEqual([])
  expect(await changedTracked(ws, '0'.repeat(40), m, names('a', outputs))).toEqual(['a'])
})

// A worker checkout whose prepare rewrote a tracked file joined on HEAD's
// tree, and a task keyed on the file saved bytes built from the rewrite
// under the clean key: a stale hit on every machine (2026-10-25).
it('refuses a worker whose checkout changed a tracked file', async () => {
  const root = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
      .stdout.toString()
      .trim()
  git('init', '-q')
  await writeFile(path.join(root, 'shared.txt'), 'committed\n')
  git('add', '-A')
  git('commit', '-qm', 'i')
  await writeFile(path.join(root, 'shared.txt'), 'rewritten\n')
  const served = servedRelay()
  try {
    const o = new Orchestrator({
      me: sealOrchestrator(
        await join(served.url, R, 'orchestrator', null, undefined),
        R,
        secretProof('s'),
      ),
      root,
      tree: git('rev-parse', 'HEAD^{tree}'),
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
    })
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => fakeArtifacts().artifacts,
    })
    expect(await Promise.race([code, Bun.sleep(5000).then(() => 'joined')])).toBe(1)
    await o.close()
    await code
  } finally {
    await served.stop()
  }
})

// `inputs.tasks` leaving the upstream out keys its bytes, which its
// worker restores: such a key was refused (2026-10-25).
it('takes a key that reads a dependency’s outputs, which its worker restores', async () => {
  const root = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', ...a], { cwd: root })
      .stdout.toString()
      .trim()
  git('init', '-q')
  await mkdir(path.join(root, 'a/dist'), { recursive: true })
  await writeFile(path.join(root, 'a/x'), 'x\n')
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'i')
  await writeFile(path.join(root, 'a/dist/out'), 'built\n')
  await writeFile(path.join(root, 'a/z'), 'z\n')
  const node = (id: string, deps: string[], outputs?: string[]) =>
    [
      id,
      {
        id,
        deps,
        projectDir: path.join(root, 'a'),
        config: outputs === undefined ? {} : { cache: { outputs: { files: outputs } } },
      } as unknown as TaskNode,
    ] as const
  const nodes = new Map([node('a#gen', [], ['dist/**']), node('a#use', ['a#gen'])])
  const served = servedRelay()
  try {
    const o = new Orchestrator({
      me: await join(served.url, R, 'orchestrator', null, undefined),
      root,
      tree: git('rev-parse', 'HEAD^{tree}'),
      nodes: () => nodes,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
    })
    const req = (...paths: string[]) =>
      ({
        taskId: 'a#use',
        inputs: { files: paths.map((p) => ({ path: p, digest: 'd' })) },
      }) as unknown as ExecuteRequest
    const queued = await Promise.race([
      o.execute(req('a/x', 'a/dist/out')).then(
        () => 'ran',
        (err: Error) => err.message,
      ),
      Bun.sleep(200).then(() => 'queued'),
    ])
    expect(queued).toBe('queued')
    await expect(o.execute(req('a/x', 'a/z'))).rejects.toThrow(
      'a#use keys a/z, which is not in the commit',
    )
    await o.close()
  } finally {
    await served.stop()
  }
})

it('names the submodule of a keyed file the run’s tree holds only as a gitlink', async () => {
  const root = await tmp()
  const git = (cwd: string, ...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd })
      .stdout.toString()
      .trim()
  git(root, 'init', '-q')
  const sub = path.join(root, 'a/vendor')
  await mkdir(sub, { recursive: true })
  await writeFile(path.join(sub, 'x'), 'x\n')
  git(sub, 'init', '-q')
  git(sub, 'add', '-A')
  git(sub, 'commit', '-qm', 'v')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'i')
  const served = servedRelay()
  try {
    const o = new Orchestrator({
      me: await join(served.url, R, 'orchestrator', null, undefined),
      root,
      tree: git(root, 'rev-parse', 'HEAD^{tree}'),
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
    })
    const req = { taskId: 'a#build', inputs: { files: [{ path: 'a/vendor/x', digest: 'd' }] } }
    await expect(o.execute(req as unknown as ExecuteRequest)).rejects.toThrow(
      "a#build keys a/vendor/x, in submodule a/vendor, whose files workers do not check out: leave it out of the task's inputs",
    )
    await o.close()
  } finally {
    await served.stop()
  }
})

// docker(), 2026-10-25: a worker that cannot host a task's sandbox faulted
// it, each worker it reached left the run, and unsandboxed tasks failed with
// no worker left. The task's own error fails the task, as core fails it.
it('fails a task on its own error and keeps the worker', async () => {
  const root = await tmp()
  await mkdir(path.join(root, 'p[1]'))
  const served = servedRelay()
  const url = served.url
  try {
    const raw = await join(url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save() {},
        async output() {
          return null
        },
        async share() {
          return false
        },
        async resend() {
          return false
        },
        async restore() {
          return null
        },
      }),
    })
    const order = (task: string, project: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [],
      nested: [],
      command: 'true',
      cwd: project,
      project,
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
      ...(project === '' ? {} : { sandbox: { config: {} } }),
    })
    const ends = new Map<string, number>()
    const seen: string[] = []
    for (let i = 0; i < 100 && ends.size < 2; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          task?: string
          result?: { exitCode: number }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, {
            type: 'batch',
            root,
            realRoot: root,
            tasks: [order('t1', 'p[1]'), order('t2', '')],
          })
        } else if (m.type === 'end') ends.set(m.task!, m.result!.exitCode)
        else seen.push(m.type)
      }
    }
    expect(seen).not.toContain('fault')
    expect(Object.fromEntries(ends)).toEqual({ t1: 1, t2: 0 })
    await raw.leave()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// 2026-10-25: a task of 9000 dependencies made an order over the relay's
// 1 MiB frame; the send was refused (413) and the task failed. Its deps go
// ahead in parts, joined by the worker.
it('sends an order too long for one frame with its deps ahead, all of them arriving', async () => {
  const ids = Array.from({ length: 9000 }, (_, i) => `some/long-dependency-task-name#build-${i}`)
  const out = { files: ['out/**'] }
  const nodes = new Map<string, TaskNode>(
    [...ids, 'final'].map((id) => [
      id,
      {
        id,
        deps: id === 'final' ? ids : [],
        projectDir: '/ws',
        config: { cache: { outputs: out } },
      } as unknown as TaskNode,
    ]),
  )
  const h = await harness(nodes, undefined, undefined, (id) => `k-${id}`)
  try {
    const a = await h.worker(1)
    void h.o.execute(h.req('final', 'k-final'))
    const deps: string[] = []
    let batch: RunOrder[] | undefined
    for (let i = 0; i < 50 && batch === undefined; i++)
      for (const { body } of await a.poll()) {
        const m = body as ToWorker
        if (m.type === 'deps') deps.push(...m.deps.map((d) => d.task))
        if (m.type === 'batch') batch = m.tasks
      }
    expect(batch?.map((o) => [o.task, o.deps.length])).toEqual([['final', 0]])
    expect(deps).toEqual(ids)
  } finally {
    await h.stop()
  }
}, 30_000)

it('restores the deps sent ahead of an order with its own', async () => {
  const root = await tmp()
  const served = servedRelay()
  const restored: string[] = []
  try {
    const raw = await join(served.url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runWorker({
      relay: served.url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save() {},
        async output() {
          return null
        },
        async share() {
          return false
        },
        async resend() {
          return false
        },
        async restore(key) {
          restored.push(key)
          return []
        },
      }),
    })
    const dep = (i: number) => ({
      task: `d${i}`,
      key: `k-d${i}`,
      project: '',
      outputs: { files: ['out/**'], workspaceFiles: [] },
    })
    const order: RunOrder = {
      task: 't',
      runKey: runKey(R, 't'),
      deps: [dep(3)],
      nested: [],
      command: 'true',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    }
    let ended = false
    for (let i = 0; i < 100 && !ended; i++)
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from === 'relay' && m.type === 'joined') {
          const w = m.id!
          await o.send(w, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 1,
            memory: 1e9,
          })
          await o.send(w, { type: 'deps', task: 't', deps: [dep(1)] })
          await o.send(w, { type: 'deps', task: 't', deps: [dep(2)] })
          await o.send(w, { type: 'batch', root, realRoot: root, tasks: [order] })
        } else if (m.type === 'end') ended = true
      }
    expect(ended).toBe(true)
    expect(restored.toSorted()).toEqual(['k-d1', 'k-d2', 'k-d3'])
    await raw.leave()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// 2026-10-25: read for each order, a run of 9000 tasks walked every task
// 9000 times to find the projects nested in each one's.
it('finds the projects nested in a task’s once per graph and project', () => {
  let walks = 0
  const nodes = new (class extends Map<string, TaskNode> {
    override values(): MapIterator<TaskNode> {
      walks++
      return super.values()
    }
  })()
  for (const [id, dir] of [
    ['a#x', '/r/a'],
    ['a#y', '/r/a'],
    ['b#x', '/r/a/b'],
    ['c#x', '/r/c'],
  ] as const)
    nodes.set(id, { projectDir: dir } as unknown as TaskNode)
  for (let i = 0; i < 100; i++) expect(nestedIn(nodes, '/r/a', '/r')).toEqual(['a/b'])
  expect(nestedIn(nodes, '/r/c', '/r')).toEqual([])
  expect(walks).toBe(1)
})

// 2026-10-25: planned after each task's end, 2000 tasks made 1281 plans,
// half the orchestrator's CPU, and its relay found the workers lost.
it('plans at most once a tick, and waits ten times a plan after it', async () => {
  let runs = 0
  const p = pace(() => {
    runs++
    const until = performance.now() + 20
    while (performance.now() < until);
  })
  const end = performance.now() + 300
  while (performance.now() < end) {
    p.soon()
    p.soon()
    await Bun.sleep(5)
  }
  // Each run of 20 ms waits 200 ms: two in 300 ms, three at most.
  expect(runs).toBeGreaterThanOrEqual(1)
  expect(runs).toBeLessThanOrEqual(3)
  const before = runs
  p.now()
  expect(runs).toBe(before + 1)
})

// Audit, 2026-10-28: a removed path through a symlinked output dir deleted
// another project's source and a file outside the workspace.
it('removes a worker’s removed outputs only where no link leads elsewhere', async () => {
  const base = await tmp()
  const ws = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  await mkdir(path.join(ws, 'pkg/dist'), { recursive: true })
  await mkdir(path.join(ws, 'other/src'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(ws, 'other/src/index.ts'), 'src')
  await writeFile(path.join(outside, 'victim'), 'x')
  await writeFile(path.join(ws, 'pkg/dist/stale.js'), 'old')
  await symlink('../../other', path.join(ws, 'pkg/dist/in'))
  await symlink(outside, path.join(ws, 'pkg/dist/out'))
  const served = servedRelay()
  const store = fakeArtifacts()
  store.saved.set('k', [])
  const said: string[] = []
  const nodes = new Map([
    ['t', { id: 't', projectDir: path.join(ws, 'pkg'), config: {} } as unknown as TaskNode],
  ])
  const o = new Orchestrator({
    me: await join(served.url, R, 'orchestrator', null, undefined),
    root: ws,
    tree: 'c',
    nodes: () => nodes,
    need: () => ({ cores: 1, memory: 10 }),
    artifacts: store.artifacts,
    cacheFacts: async () => ({ refs: [], lent: {} }),
    run: R,
    keyOf: () => undefined,
    warn: (m) => said.push(m),
  })
  try {
    const w = await join(
      served.url,
      R,
      'worker',
      { v: 1, cores: 1, memory: 100, tree: 'c' },
      undefined,
    )
    const run = o.execute({
      taskId: 't',
      workspaceRoot: ws,
      command: 'true',
      forwardArgs: [],
      cwd: path.join(ws, 'pkg'),
      env: {},
      envDefine: {},
      outputs: { files: ['dist/**'], workspaceFiles: [] },
      onStdout() {},
      onStderr() {},
    } as unknown as ExecuteRequest)
    for (let i = 0; i < 20; i++)
      if ((await w.poll()).some((m) => (m.body as { type: string }).type === 'batch')) break
    await w.send('orchestrator', {
      type: 'end',
      task: 't',
      key: 'k',
      result: {
        exitCode: 0,
        durationMs: 1,
        removed: ['pkg/dist/stale.js', 'pkg/dist/in/src/index.ts', 'pkg/dist/out/victim'],
      },
    })
    expect((await run).exitCode).toBe(0)
    expect((await readdir(path.join(ws, 'pkg/dist'))).sort()).toEqual(['in', 'out'])
    expect(await readdir(path.join(ws, 'other/src'))).toEqual(['index.ts'])
    expect(await readdir(outside)).toEqual(['victim'])
    expect(said).toEqual([
      '[vx] dte: t: kept pkg/dist/in/src/index.ts, which the worker removed: a link on its path leads elsewhere',
      '[vx] dte: t: kept pkg/dist/out/victim, which the worker removed: a link on its path leads elsewhere',
    ])
  } finally {
    await o.close()
    await served.stop()
  }
})
