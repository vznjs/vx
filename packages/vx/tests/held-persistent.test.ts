// `holdPersistent` (the watch loop) hands the run's requested servers back
// still running. They still write, and the run's renderer must still hear
// them until the caller stops them: `vx watch dev` printed none of its
// server's log while it idled, the renderer unsubscribed as run() returned
// (C-57).

import { writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { createEventBus, run, type Logger } from '../src/orchestrator/index.js'

process.env['VX_KILL_GRACE_MS'] = '200'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-held-' })
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
