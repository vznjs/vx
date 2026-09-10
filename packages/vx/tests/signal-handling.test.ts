// SIGINT/SIGTERM during `run()`: every live child (one-shot AND
// persistent) gets SIGTERM, a survivor is SIGKILLed after the grace, the
// cache handle closes, and vx exits with 128+signo (130/143). The e2e tests spawn the real CLI as a
// subprocess because signal delivery + process exit can't be
// asserted in-process; the listener-leak test runs in-process
// because that's exactly where stacking handlers would hurt
// (watch loop, bun test).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

// The SIGTERM→SIGKILL grace is 2 s by default; every test here that proves
// the escalation would wait it out. 200 ms proves the same claim
// (`VX_KILL_GRACE_MS`, see util/settle.ts); children inherit it.
process.env['VX_KILL_GRACE_MS'] = '200'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

interface Fixture {
  root: string
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-signal-' })
  return { root }
}

// The shell's `echo $$ > pid.txt` truncates the file before it writes it;
// a read that lands between sees '' and Number('') is 0, and kill(0, 0)
// probes the caller's own process group — alive forever. Under an
// eight-shard gate that window was hit once. Wait for the number, not the
// file.
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

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

describe('signal handling during vx run (e2e)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'SIGTERM kills the in-flight one-shot child and exits 143',
    async () => {
      // `exec` keeps the pid in pid.txt identical to vx's direct child,
      // so kill(pid, 0) probes exactly the process vx must reap.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: {
                exec: { command: 'echo $$ > pid.txt; echo started; exec sleep 30' },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pidFile = path.join(dir, 'pid.txt')
      const pid = await waitForPid(pidFile, 10_000)
      expect(isAlive(pid)).toBe(true)

      proc.kill('SIGTERM')
      const code = await proc.exited
      expect(code).toBe(143)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'SIGTERM kills a ready persistent child and exits 143',
    async () => {
      // `hold` keeps the graph in flight after `dev` becomes ready, so
      // the signal arrives while the persistent child is alive and
      // owned by the orchestrator's registry.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo $$ > pid.txt; echo READY; exec sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
              hold: {
                exec: { command: 'sleep 30' },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', 'hold', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pidFile = path.join(dir, 'pid.txt')
      const pid = await waitForPid(pidFile, 10_000)
      expect(isAlive(pid)).toBe(true)

      proc.kill('SIGTERM')
      const code = await proc.exited
      expect(code).toBe(143)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a child that ignores SIGTERM is SIGKILLed after the grace; vx still exits 143',
    async () => {
      // SIG_IGN survives exec, so the `sleep` vx SIGTERMs shrugs it off —
      // exactly a dev server mid-cleanup or a runner that traps TERM.
      // Before the escalation vx exited 143 and left it running under
      // init; this pin fails that way without the fix.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              stubborn: {
                exec: { command: "trap '' TERM; echo $$ > pid.txt; exec sleep 30" },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'stubborn', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      expect(isAlive(pid)).toBe(true)

      proc.kill('SIGTERM')
      const code = await proc.exited
      expect(code).toBe(143)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a second signal during the grace SIGKILLs at once',
    async () => {
      // Grace long enough that only the second signal can explain a fast
      // exit: 5 s of grace versus a 2.5 s bound on the whole teardown.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              stubborn: {
                exec: { command: "trap '' TERM; echo $$ > pid.txt; exec sleep 30" },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'stubborn', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, VX_KILL_GRACE_MS: '5000' },
      })
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      expect(isAlive(pid)).toBe(true)

      const started = Date.now()
      proc.kill('SIGINT')
      await Bun.sleep(100)
      proc.kill('SIGINT')
      const code = await proc.exited
      expect(code).toBe(130)
      expect(Date.now() - started).toBeLessThan(2_500)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'SIGINT exits 130',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: {
                exec: { command: 'echo $$ > pid.txt; exec sleep 30' },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pidFile = path.join(dir, 'pid.txt')
      const pid = await waitForPid(pidFile, 10_000)

      proc.kill('SIGINT')
      const code = await proc.exited
      expect(code).toBe(130)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )
})

describe('signal handler lifecycle (in-process)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
    await addProject(
      fixture.root,
      'app',
      `
        export default {
          tasks: {
            hello: {
              exec: { command: 'echo hello' },
            },
          },
        }
      `,
    )
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'run() removes its SIGINT/SIGTERM listeners — repeated runs never stack',
    async () => {
      const before = {
        int: process.listenerCount('SIGINT'),
        term: process.listenerCount('SIGTERM'),
      }
      for (let i = 0; i < 2; i++) {
        const r = await run({
          cwd: fixture.root,
          tasks: ['hello'],
          projects: ['app'],
          log: silentLogger,
        })
        expect(r.ok).toBe(true)
        expect(process.listenerCount('SIGINT')).toBe(before.int)
        expect(process.listenerCount('SIGTERM')).toBe(before.term)
      }
    },
    TIMEOUT,
  )

  it(
    'handlers are live during the run by default; handleSignals: false installs none',
    async () => {
      // log.status fires while the run is in flight, so sampling the
      // listener count there observes the installed-handler window.
      const counts: number[] = []
      const probe: Logger = {
        status() {
          counts.push(process.listenerCount('SIGTERM'))
        },
        taskStdout() {},
        taskStderr() {},
        taskComplete() {},
      }
      const base = process.listenerCount('SIGTERM')

      await run({ cwd: fixture.root, tasks: ['hello'], projects: ['app'], log: probe })
      expect(Math.max(...counts)).toBe(base + 1)

      counts.length = 0
      await run({
        cwd: fixture.root,
        tasks: ['hello'],
        projects: ['app'],
        handleSignals: false,
        log: probe,
      })
      expect(Math.max(...counts)).toBe(base)
    },
    TIMEOUT,
  )
})
