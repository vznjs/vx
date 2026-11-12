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
import { createEventBus, defaultLogger, type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

process.env['VX_TEST_KILL_GRACE'] = '200ms'

// Interrupts once `id` is ready, not at a set time: a 500 ms timer fired
// before the server was ready on a loaded CI runner, so nothing was held.
const interruptOnReady = (interrupt: AbortController, id: string): Logger => ({
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete: (node) => {
    if (node.id === id) interrupt.abort(CYCLE_INTERRUPT)
  },
})

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
}, 30_000)

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
}, 30_000)

// `RunOptions.keep` (the watch loop's next cycle): a server still up whose
// task is unchanged stays up while its dependency rebuilds, and what it
// writes reaches the new run's logger. A config change replaces it.
it('a later run keeps an unchanged held server, rebuilds its deps, and replaces a changed one', async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'echo built >> ../../built.log' },
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
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
        dependsOn: ['dev'], inputs: { files: ['e2e.txt'] }, outputs: { files: [] }, cache: true,
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
  const second = await run({
    cwd: root,
    tasks: ['api', 'web'],
    projects: ['app'],
    log: interruptOnReady(interrupt, 'app#api'),
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

// What a server wrote in the chunk that held its ready line went to the
// frame a success row never prints: Vite's `Network:` line after
// `readyWhen: 'Local:'` was never shown, and a partial line after the ready
// one lost its first piece.
it("a server's lines after its ready line, in the same write, show once", async () => {
  // `%s`: the command line a frame prints must not hold the text looked for.
  const srv = (id: string): string =>
    `${id}: { exec: { command: 'printf "READY\\\\nAFTER-%s\\\\nPART-" ${id}; sleep 0.3; printf "%s-END\\\\n" ${id}; exec sleep 30', persistent: { readyWhen: 'READY' } } }`
  await addProject(root, 'app', {
    config: `export default { tasks: { ${srv('api')}, ${srv('web')} } }`,
  })
  let text = ''
  const log = defaultLogger(
    { enabled: false },
    { mode: 'broad' },
    { write: (c: string) => ((text += c), true) },
  )
  const r = await run({
    cwd: root,
    tasks: ['api', 'web'],
    projects: ['app'],
    log,
    handleSignals: false,
    holdPersistent: true,
  })
  try {
    const deadline = Date.now() + 5_000
    while (!(text.includes('api-END') && text.includes('web-END')) && Date.now() < deadline)
      await Bun.sleep(20)
    // Since ready: in the block at the summary (a partial line ends it), or
    // a line at a time under the server's id after it.
    for (const id of ['api', 'web']) {
      expect([
        text.split(`AFTER-${id}\nPART-`).length,
        text.split(`AFTER-${id}`).length,
        text.split(`app#${id} │ ${id}-END\n`).length,
      ]).toEqual([2, 2, 2])
    }
  } finally {
    await r.persistent?.stop()
  }
}, 30_000)

// The initial run of `vx watch` is handed no servers: an edit while one
// server still started stopped the run, and the one already ready went
// down with it and restarted. A server ready within the interrupted run
// is spared and handed back, as a handed one is.
it('a run interrupted on readiness keeps the servers it made ready', async () => {
  await addProject(root, 'app', {
    config: `export default { tasks: {
      api: { exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      web: { exec: { command: 'echo booting; exec sleep 30', persistent: { readyWhen: 'READY' } } },
    } }`,
  })
  const interrupt = new AbortController()
  const r = await run({
    cwd: root,
    tasks: ['api', 'web'],
    projects: ['app'],
    log: interruptOnReady(interrupt, 'app#api'),
    handleSignals: false,
    holdPersistent: true,
    signal: interrupt.signal,
  })
  const api = r.persistent?.servers.get('app#api')?.child
  try {
    expect([r.persistent?.ids, api?.exitCode, api?.signalCode]).toEqual([['app#api'], null, null])
  } finally {
    await r.persistent?.stop()
  }
}, 30_000)

// Each cycle that kept a server tied a fresh exit listener to the same
// long-lived child, closing over that cycle's run: `vx watch dev` grew
// by ~13 statements, maps and closures a cycle, ~90 MB of RSS over 460
// cycles, and gave none of it back until the server exited.
it("a server kept over many cycles does not keep the earlier cycles' runs", async () => {
  await addProject(root, 'app', {
    config: `export default { tasks: { dev: { exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } } } }`,
  })
  const logs: WeakRef<Logger>[] = []
  const cycle = async (keep?: HeldPersistent): Promise<HeldPersistent> => {
    const log: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
    logs.push(new WeakRef(log))
    return (
      await run({
        cwd: root,
        tasks: ['dev'],
        projects: ['app'],
        log,
        handleSignals: false,
        holdPersistent: true,
        ...(keep !== undefined ? { keep } : {}),
      })
    ).persistent!
  }
  let held = await cycle()
  const child = held.servers.get('app#dev')!.child
  try {
    // As the watch loop does: the next cycle keeps it, then the last stops the rest.
    for (let i = 0; i < 5; i++) {
      const next = await cycle(held)
      await held.stop()
      held = next
    }
    expect(held.servers.get('app#dev')!.child).toBe(child)
    // The first run reads the server's output and the last one holds it;
    // the one stopped last may still be settling. The ones between are done.
    const between = (): number => logs.slice(1, -2).filter((w) => w.deref() !== undefined).length
    for (let i = 0; i < 5 && between() > 0; i++) {
      await Bun.sleep(10)
      Bun.gc(true)
    }
    expect(between()).toBe(0)
  } finally {
    await held.stop()
  }
}, 30_000)

// `vx watch e2e` over servers e2e only depends on stopped them at the end
// of each cycle, so every edit booted the whole stack again; only a
// requested server was held. A dependency-only server is held too, but
// kept only while its key is: e2e against an api whose source changed
// tested the old api. One with no input files has no key that sees an
// edit, so it restarts each cycle. A requested one reloads itself and
// restarts only on a config edit.
it('a held run keeps a dependency-only server while its key is unchanged', async () => {
  const app = await addProject(root, 'app', {
    config: `export default { tasks: {
      db: { inputs: { files: ['db.txt'] }, exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      mq: { exec: { command: 'echo up >> ../../mq.log; echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      web: { inputs: { files: ['web.txt'] }, exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      e2e: { dependsOn: ['db', 'mq'], exec: { command: 'true' } },
    } }`,
    files: { 'db.txt': 'v1', 'web.txt': 'v1' },
  })
  const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  const cycle = async (keep?: HeldPersistent) => {
    const r = await run({
      cwd: root,
      tasks: ['e2e', 'web'],
      projects: ['app'],
      log: quiet,
      handleSignals: false,
      holdPersistent: true,
      ...(keep !== undefined ? { keep } : {}),
    })
    // As the watch loop does: what this cycle did not take goes.
    await keep?.stop()
    expect(r.ok).toBe(true)
    return r.persistent!
  }
  const pids = (h: HeldPersistent): (number | undefined)[] =>
    ['app#db', 'app#mq', 'app#web'].map((id) => h.servers.get(id)?.child.pid)
  const all: HeldPersistent[] = []
  try {
    all.push(await cycle())
    const [db1, , web1] = pids(all[0]!)
    expect([db1, web1].every((p) => p !== undefined)).toBe(true)
    all.push(await cycle(all[0]))
    const [db2, , web2] = pids(all[1]!)
    expect([db2 === db1, web2 === web1]).toEqual([true, true])
    writeFileSync(path.join(app, 'db.txt'), 'v2')
    writeFileSync(path.join(app, 'web.txt'), 'v2')
    const old = all[1]!.servers.get('app#db')!.child
    all.push(await cycle(all[1]))
    const [db3, , web3] = pids(all[2]!)
    expect([
      db3 !== undefined && db3 !== db2,
      old.signalCode ?? old.exitCode,
      web3 === web1,
    ]).toEqual([true, 'SIGTERM', true])
    expect(readFileSync(path.join(root, 'mq.log'), 'utf8')).toBe('up\nup\nup\n')
  } finally {
    for (const h of all.reverse()) await h.stop()
  }
}, 30_000)
