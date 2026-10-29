// A bus an embedder passes outlives its runs (item 635): a run takes off
// every subscriber it put on, or each run leaves one more behind.

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { createEventBus, type EventBus, type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-bus-subs-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A bus that counts the subscribers still on it. */
function countingBus(): EventBus & { live: () => number } {
  const inner = createEventBus()
  let live = 0
  return {
    emit: (e) => inner.emit(e),
    subscribe(s) {
      live++
      const off = inner.subscribe(s)
      let gone = false
      return () => {
        if (gone) return
        gone = true
        live--
        off()
      }
    },
    live: () => live,
  }
}

it('a run leaves no subscriber on the bus it was given', async () => {
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  const bus = countingBus()
  for (let i = 0; i < 2; i++) {
    const r = await run({ bus, cwd: root, tasks: ['t'], log: quiet, handleSignals: false })
    expect(r.ok).toBe(true)
    expect(bus.live()).toBe(0)
  }
}, 20_000)
