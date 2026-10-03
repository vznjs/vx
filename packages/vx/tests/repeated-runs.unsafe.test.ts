// An embedder runs many runs in one process (`vx watch`, a daemon): each
// must give back what it took. Twenty runs of a graph with a cached task,
// a server, a task on the server, and (where the sandbox exists) a
// sandboxed task, alternating `handleSignals` and `holdPersistent`: from
// the fifth run on, the open descriptors never grow and the process's
// signal and exit listeners hold steady. A probe of 200 such runs found
// them steady and RSS flat at ~108 MB (C-83). Unsafe: it reads this process's
// /proc/self/fd, which a sandboxed shard's /proc is not.

import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { probeSandbox } from '../src/exec/index.js'
import { addProject, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const silent: Logger = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

let root = ''
let sandboxed = false
beforeAll(async () => {
  sandboxed = (await probeSandbox()).available
  root = await makeWorkspace({ prefix: 'vx-repeat-' })
  await addProject(root, 'a', {
    config: `export default { tasks: {
      build: { exec: { command: 'echo b > out.txt' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } },
      srv: { dependsOn: ['build'], exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
      t: { dependsOn: ['srv'], exec: { command: 'true' } },
      sb: { exec: { command: 'true', sandbox: {} } },
    } }`,
    files: { 'src/x.txt': 'x' },
  })
  gitInitCommit(root)
})
afterAll(() => rm(root, { recursive: true, force: true }))

const held = () => ({
  fds: readdirSync('/proc/self/fd').length,
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
  SIGHUP: process.listenerCount('SIGHUP'),
  exit: process.listenerCount('exit'),
})

it.skipIf(process.platform !== 'linux')(
  'twenty runs in one process hold their descriptors and listeners steady',
  async () => {
    let steady: ReturnType<typeof held> | undefined
    for (let i = 0; i < 20; i++) {
      const r = await run({
        cwd: root,
        tasks: sandboxed ? ['a#t', 'a#sb'] : ['a#t'],
        log: silent,
        handleSignals: i % 2 === 0,
        holdPersistent: i % 3 === 0,
      })
      expect(r.ok).toBe(true)
      await r.persistent?.stop()
      if (i === 4) steady = held()
    }
    // The claim is no growth: a descriptor still closing at the fifth run
    // can be gone by the twentieth, and an exact count failed on CI at
    // 18 → 17. Descriptors may fall, never rise; listeners hold exactly.
    const { fds, ...listeners } = held()
    const { fds: steadyFds, ...steadyListeners } = steady!
    expect(listeners).toEqual(steadyListeners)
    expect(fds).toBeLessThanOrEqual(steadyFds)
  },
  60_000,
)
