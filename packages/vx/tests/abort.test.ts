// `RunOptions.signal`: an embedder aborts a run from outside. The running
// child is SIGTERMed (SIGKILLed after the grace when it traps TERM), the
// never-started dependents complete `aborted`, and run() returns to its
// caller — the watch loop's Ctrl-C path, and the seam for any host that
// owns its process's signals instead of `handleSignals`.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

process.env['VX_KILL_GRACE_MS'] = '200'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

async function waitForPid(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = Bun.file(file)
    if (await f.exists()) {
      const pid = Number((await f.text()).trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for a pid in ${file}`)
}

describe('RunOptions.signal aborts a run in flight', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-abort-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('kills the running child, marks it and its dependents aborted, and returns', async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } },
            after: { dependsOn: ['slow'], exec: { command: 'echo never' } },
          },
        }
      `,
    )
    const ac = new AbortController()
    const started = Date.now()
    const running = run({
      cwd: root,
      tasks: ['after'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    expect(isAlive(pid)).toBe(true)
    ac.abort()
    const r = await running
    expect(r.ok).toBe(false)
    expect(
      r.outcomes.map((o) => [o.node.id, o.status]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    ).toEqual([
      ['app#after', 'aborted'],
      ['app#slow', 'aborted'],
    ])
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  it('a child that ignores SIGTERM is SIGKILLed after the grace', async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            stubborn: { exec: { command: "trap '' TERM; echo $$ > pid.txt; exec sleep 30" } },
          },
        }
      `,
    )
    const ac = new AbortController()
    const running = run({
      cwd: root,
      tasks: ['stubborn'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    ac.abort()
    const r = await running
    expect(r.ok).toBe(false)
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  it('an already-aborted signal runs nothing: every task completes aborted', async () => {
    await addProject(
      root,
      'app',
      `
        export default {
          tasks: { hello: { exec: { command: 'echo hello > ran.txt' } } },
        }
      `,
    )
    const ac = new AbortController()
    ac.abort()
    const r = await run({
      cwd: root,
      tasks: ['hello'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    expect(r.ok).toBe(false)
    expect(r.outcomes.map((o) => o.status)).toEqual(['aborted'])
    expect(await Bun.file(path.join(root, 'packages', 'app', 'ran.txt')).exists()).toBe(false)
  }, 20_000)
})
