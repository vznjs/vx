// `holdPersistent` (the watch loop) hands the run's requested servers back
// still running. They still write, and the run's renderer must still hear
// them until the caller stops them: `vx watch dev` printed none of its
// server's log while it idled, the renderer unsubscribed as run() returned
// (C-57).

import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { CYCLE_INTERRUPT, type HeldPersistent } from '../src/orchestrator/index.js'
import { createEventBus, type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

process.env['VX_TEST_KILL_GRACE'] = '200ms'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-held-', edges: { app: ['lib'] } })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it("a held server's output reaches the run's logger until it is stopped", async () => {
  const dir = await addProject(
    root,
    'app',
    `export default { tasks: { srv: { exec: {
      command: 'echo READY; while [ ! -f go ]; do sleep 0.02; done; echo AFTER-RETURN; exec sleep 30',
      persistent: { readyWhen: 'READY' },
    } } } }`,
  )
  let heard = ''
  const log: Logger = {
    status() {},
    taskStdout: (_n, chunk) => void (heard += chunk),
    taskStderr() {},
    taskComplete() {},
  }
  const bus = createEventBus()
  const r = await run({
    bus,
    cwd: root,
    tasks: ['srv'],
    projects: ['app'],
    log,
    handleSignals: false,
    holdPersistent: true,
  })
  expect(r.persistent?.ids).toEqual(['app#srv'])
  writeFileSync(path.join(dir, 'go'), '')
  const deadline = Date.now() + 5_000
  while (!heard.includes('AFTER-RETURN') && Date.now() < deadline) await Bun.sleep(20)
  await r.persistent!.stop()
  expect(heard).toContain('AFTER-RETURN')
  // Stopped, the renderer leaves the bus: a bus outlives its runs (item 635).
  const node = r.outcomes[0]!.node
  bus.emit({ kind: 'task:stdout', node, chunk: 'AFTER-STOP' })
  expect(heard).not.toContain('AFTER-STOP')
}, 20_000)

// C-60: a foreground run that failed holds no server; the watch loop's
// cycle still does, so a failing test does not stop its dev server.
it('a held run hands its server back though another task failed', async () => {
  await addProject(
    root,
    'app',
    `export default { tasks: {
      srv: { exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      test: { exec: { command: 'exit 1' } },
    } }`,
  )
  const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  const r = await run({
    cwd: root,
    tasks: ['srv', 'test'],
    projects: ['app'],
    log: quiet,
    handleSignals: false,
    holdPersistent: true,
  })
  try {
    expect([r.ok, r.persistent?.ids]).toEqual([false, ['app#srv']])
  } finally {
    await r.persistent?.stop()
  }
}, 20_000)

// `RunOptions.keep` (the watch loop's next cycle): a server still up whose
// task is unchanged stays up while its dependency rebuilds, and what it
// writes reaches the new run's logger. A config change replaces it.
it('a later run keeps an unchanged held server, rebuilds its deps, and replaces a changed one', async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'echo built >> ../../built.log' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    } } }`,
    files: { 'src/a.txt': 'v1' },
  })
  const srv = (word: string): string =>
    `export default { tasks: { dev: {
      dependsOn: ['^build'],
      exec: {
        command: 'echo READY; while [ ! -f ${word} ]; do sleep 0.02; done; echo ${word}-SEEN; exec sleep 30',
        persistent: { readyWhen: 'READY' },
      },
    } } }`
  const app = await addProject(root, 'app', { config: srv('go') })
  const builds = (): number =>
    readFileSync(path.join(root, 'built.log'), 'utf8').split('\n').filter(Boolean).length
  const heard: string[] = ['', '', '']
  const cycle = (i: number, keep?: HeldPersistent) =>
    run({
      cwd: root,
      tasks: ['dev'],
      projects: ['app'],
      log: {
        status() {},
        taskStdout: (_n, chunk) => void (heard[i] += chunk),
        taskStderr() {},
        taskComplete() {},
      },
      handleSignals: false,
      holdPersistent: true,
      ...(keep !== undefined ? { keep } : {}),
    })
  const r1 = (await cycle(0)).persistent!
  const child = r1.servers.get('app#dev')!.child
  writeFileSync(path.join(lib, 'src', 'a.txt'), 'v2')
  const second = await cycle(1, r1)
  const r2 = second.persistent!
  // What the second run did not take: nothing, so the server survives it.
  await r1.stop()
  try {
    expect(second.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
      'app#dev success',
      'lib#build success',
    ])
    expect([r2.servers.get('app#dev')!.child === child, child.exitCode, builds()]).toEqual([
      true,
      null,
      2,
    ])
    writeFileSync(path.join(app, 'go'), '')
    const deadline = Date.now() + 5_000
    while (!heard[1]!.includes('go-SEEN') && Date.now() < deadline) await Bun.sleep(20)
    expect([heard[0]!.includes('go-SEEN'), heard[1]!.includes('go-SEEN')]).toEqual([false, true])

    writeFileSync(path.join(app, 'vx.config.mjs'), srv('again'))
    const r3 = (await cycle(2, r2)).persistent!
    try {
      expect(r3.servers.get('app#dev')!.child === child).toBe(false)
      expect(child.signalCode ?? child.exitCode).not.toBeNull()
      expect(builds()).toBe(2)
    } finally {
      await r3.stop()
    }
  } finally {
    await r2.stop()
  }
}, 30_000)

// A kept server is keyed like a started one (A-17): a cached dependant
// folds its key, so an edit to the server's sources re-runs it. The kept
// outcome carried no hash, and from the watch loop's third cycle on the
// dependant hit under a key blind to every server edit.
it("a kept server's key still reaches its cached dependant", async () => {
  const app = await addProject(root, 'app', {
    config: `export default { tasks: {
      dev: { inputs: { files: ['src/**'] }, exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      e2e: {
        dependsOn: ['dev'], inputs: { files: ['e2e.txt'] }, cache: { outputs: { files: [] } },
        exec: { command: 'echo ran >> ../../e2e.log' },
      },
    } }`,
    files: { 'src/a.txt': 'v0', 'e2e.txt': '' },
  })
  const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  const cycle = (keep?: HeldPersistent) =>
    run({
      cwd: root,
      tasks: ['dev', 'e2e'],
      projects: ['app'],
      log: quiet,
      handleSignals: false,
      holdPersistent: true,
      ...(keep !== undefined ? { keep } : {}),
    })
  const runs = (): number =>
    readFileSync(path.join(root, 'e2e.log'), 'utf8').split('\n').filter(Boolean).length
  let held = (await cycle()).persistent!
  try {
    for (const v of ['v1', 'v2', 'v3']) {
      writeFileSync(path.join(app, 'src', 'a.txt'), v)
      const next = (await cycle(held)).persistent!
      await held.stop()
      held = next
    }
    expect(runs()).toBe(4)
  } finally {
    await held.stop()
  }
}, 30_000)

// `vx watch` stops a cycle that waits on a server never ready (WD-15).
// That stop took down the servers the cycle was handed too: an unchanged
// dev server restarted on an edit to its neighbour's.
it('a cycle interrupted on readiness keeps the servers it was handed', async () => {
  const srv = (never: boolean): string =>
    `export default { tasks: {
      api: { exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      web: { exec: { command: '${never ? 'echo booting' : 'echo READY'}; exec sleep 30', persistent: { readyWhen: 'READY' } } },
    } }`
  const app = await addProject(root, 'app', { config: srv(false) })
  const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  const first = (
    await run({
      cwd: root,
      tasks: ['api', 'web'],
      projects: ['app'],
      log: quiet,
      handleSignals: false,
      holdPersistent: true,
    })
  ).persistent!
  const api = first.servers.get('app#api')!.child
  writeFileSync(path.join(app, 'vx.config.mjs'), srv(true))
  const interrupt = new AbortController()
  setTimeout(() => interrupt.abort(CYCLE_INTERRUPT), 500)
  const second = await run({
    cwd: root,
    tasks: ['api', 'web'],
    projects: ['app'],
    log: quiet,
    handleSignals: false,
    holdPersistent: true,
    keep: first,
    signal: interrupt.signal,
  })
  await first.stop()
  try {
    expect([api.exitCode, api.signalCode, second.persistent?.ids]).toEqual([
      null,
      null,
      ['app#api'],
    ])
  } finally {
    await second.persistent?.stop()
    api.kill('SIGKILL')
  }
}, 30_000)
