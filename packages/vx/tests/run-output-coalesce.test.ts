// A run's terminal output is coalesced off a TTY: a warm 476-package run
// wrote each of its 952 task lines as its own write, and batching them
// per turn of the event loop took 16 ms off its wall (item 753). The row
// counts the writes carrying task lines that a run hands to stdout for
// twenty cache hits.
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const N = 20

describe('a run writes its task lines to stdout coalesced', () => {
  let root = ''
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-coalesce-' })
    for (let i = 0; i < N; i++) {
      await addProject(
        root,
        `p${i}`,
        `
          export default {
            tasks: {
              t: { exec: { command: 'true' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } } },
            },
          }
        `,
      )
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(`${N} cache hits reach stdout in fewer writes than lines`, async () => {
    const cold = await run({
      cwd: root,
      tasks: ['t'],
      log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
    })
    expect(cold.ok).toBe(true)
    const writes: string[] = []
    const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const warm = await run({ cwd: root, tasks: ['t'] })
      expect(warm.ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
    const text = writes.join('')
    const lines = [...Array(N).keys()].filter((i) => text.includes(`p${i}#t`)).length
    expect(lines).toBe(N)
    // One write per turn of the event loop: the twenty hits land in a few
    // turns, never one write each (without coalescing, twenty).
    const taskWrites = writes.filter((w) => /p\d+#t/.test(w)).length
    expect(taskWrites).toBeLessThanOrEqual(N / 4)
  })
})
