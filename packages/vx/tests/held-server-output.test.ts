// `vx watch` hands a run's dev server to the next run (`RunOptions.keep`).
// What the server writes while that run builds its dependencies belongs to
// that run's renderer: it went to the earlier one, which wrote it over the
// new run's status frame, and the frame's next redraw erased it.

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-held-out-', edges: { app: [] } })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const capture = (): { logger: Logger; out: () => string; warned: () => string[] } => {
  let text = ''
  const warned: string[] = []
  return {
    logger: {
      status: () => {},
      warn: (line) => void warned.push(line),
      taskStdout: (_n, chunk) => void (text += chunk),
      taskStderr: () => {},
      taskComplete: () => {},
    },
    out: () => text,
    warned: () => warned,
  }
}

describe('a server held from an earlier run', () => {
  it("writes into the run that keeps it from that run's start", async () => {
    // `slow` signals the server the second time it runs, then holds the
    // run while the server writes.
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            slow: { exec: { command: 'if [ -f armed ]; then touch go; sleep 0.8; fi' } },
            dev: {
              dependsOn: ['slow'],
              exec: {
                command: 'echo READY; while [ ! -f go ]; do sleep 0.02; done; echo DURING; exec sleep 30',
                persistent: { readyWhen: 'READY' },
              },
            },
          },
        }
      `,
    })
    const one = capture()
    const first = await run({ cwd: root, tasks: ['dev'], log: one.logger, holdPersistent: true })
    expect(first.persistent?.ids).toEqual(['app#dev'])
    await Bun.write(`${root}/packages/app/armed`, '')
    const two = capture()
    const second = await run({
      cwd: root,
      tasks: ['dev'],
      log: two.logger,
      holdPersistent: true,
      keep: first.persistent!,
    })
    await second.persistent?.stop()
    await first.persistent!.stop()
    expect(second.ok).toBe(true)
    expect({ first: one.out().includes('DURING'), second: two.out().includes('DURING') }).toEqual({
      first: false,
      second: true,
    })
  }, 30_000)

  it('that dies while the run that keeps it builds is said by that run', async () => {
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            slow: { exec: { command: 'if [ -f armed ]; then touch go; sleep 0.8; fi' } },
            dev: {
              dependsOn: ['slow'],
              exec: {
                command: 'echo READY; while [ ! -f go ]; do sleep 0.02; done; exit 3',
                persistent: { readyWhen: 'READY' },
              },
            },
          },
        }
      `,
    })
    const one = capture()
    const first = await run({ cwd: root, tasks: ['dev'], log: one.logger, holdPersistent: true })
    await Bun.write(`${root}/packages/app/armed`, '')
    const two = capture()
    const second = await run({
      cwd: root,
      tasks: ['dev'],
      log: two.logger,
      holdPersistent: true,
      keep: first.persistent!,
    })
    await second.persistent?.stop()
    await first.persistent!.stop()
    const died = (w: string[]): boolean => w.some((l) => l.includes('app#dev exited with code 3'))
    expect({ first: died(one.warned()), second: died(two.warned()) }).toEqual({
      first: false,
      second: true,
    })
  }, 30_000)
})
