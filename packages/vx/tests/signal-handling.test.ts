// SIGINT/SIGTERM during `run()`: every live child (one-shot AND
// persistent) gets SIGTERM, a survivor is SIGKILLed after the grace, the
// cache handle closes, and vx exits with 128+signo (130/143). The e2e tests spawn the real CLI as a
// subprocess because signal delivery + process exit can't be
// asserted in-process; the listener-leak test runs in-process
// because that's exactly where stacking handlers would hurt
// (watch loop, bun test).

import { getEventListeners } from 'node:events'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { terminateChildren } from '../src/orchestrator/signals.js'

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
    'the SECOND signal does not change the exit code',
    async () => {
      // The row above sends SIGINT twice, so "exit with the FIRST signal's
      // code" and "exit with the second's" give the same 130 and it cannot
      // tell them apart. Two DIFFERENT signals can: the run ended when the
      // first one arrived, and the second only says "now".
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

      proc.kill('SIGINT')
      await Bun.sleep(100)
      proc.kill('SIGTERM')
      const code = await proc.exited
      // 130, not 143: SIGINT ended this run.
      expect(code).toBe(130)
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

  // A task runs in its own session, so a terminal's Ctrl-C reaches vx
  // alone, and vx forwards what it received. It forwarded SIGTERM for
  // every signal, so a cleanup bound to SIGINT alone — Node's
  // `process.on('SIGINT')`, a shell's `trap … INT` — never ran
  // (turborepo#444, #12652, #13097, nx#23585 reproduced on vx,
  // 2026-09-24). The task records which signal reached it; SIGTERM is the
  // control that passes either way.
  const TRAPS =
    "trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM"
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    for (const persistent of [false, true]) {
      const kind = persistent ? 'a ready persistent task' : 'a one-shot task'
      it(
        `${signal} to vx reaches ${kind} as ${signal}`,
        async () => {
          const dir = await addProject(
            fixture.root,
            'app',
            `
              export default {
                tasks: {
                  t: {
                    exec: {
                      command: "${TRAPS}; echo $$ > pid.txt; echo READY; while :; do sleep 0.05; done",
                      ${persistent ? "persistent: { readyWhen: 'READY' }," : ''}
                    },
                  },
                },
              }
            `,
          )
          const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
            cwd: fixture.root,
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
          proc.kill(signal)
          expect(await proc.exited).toBe(code)
          expect((await Bun.file(path.join(dir, 'got.txt')).text()).trim()).toBe(signal)
          expect(await waitForDead(pid, 3_000)).toBe(true)
        },
        TIMEOUT,
      )
    }
  }

  it.skipIf(process.platform !== 'linux')(
    'a task runs in its own session, so a Ctrl-C from the terminal reaches vx alone',
    async () => {
      // The terminal signals its foreground process group, which is vx's;
      // a task in vx's group would get the Ctrl-C twice, once from the
      // terminal and once forwarded. Field 6 of /proc/<pid>/stat is the
      // session id; a session leader's is its own pid. The shell reads its
      // own line through /proc/self: under the sandbox's nested pid
      // namespace procfs numbers processes differently from `$$`.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              t: { exec: { command: 'read -r pid comm state ppid pgrp sid rest < /proc/self/stat; echo $pid $pgrp $sid > ids.txt' } },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(0)
      const [pid, pgrp, sid] = (await Bun.file(path.join(dir, 'ids.txt')).text())
        .trim()
        .split(' ')
        .map(Number)
      expect(pgrp).toBe(pid!)
      expect(sid).toBe(pid!)
      expect(sid).not.toBe(proc.pid)
    },
    TIMEOUT,
  )
})

describe('terminateChildren — the second sweep re-reads what is live', () => {
  it(
    'a child that appears DURING the grace is killed by the second sweep',
    async () => {
      // The SIGKILL pass calls `live()` again rather than reusing the list
      // it SIGTERMed, because the run loop may still be dispatching while
      // the grace runs — a child spawned after the first sweep would
      // otherwise be signalled by nobody and outlive the run under init.
      // Nothing held that: every fixture has a child set that is fixed for
      // the whole teardown, so reusing the first list gives the same answer.
      const spawnStubborn = (): ReturnType<typeof Bun.spawn> =>
        Bun.spawn(['sh', '-c', "trap '' TERM; sleep 30"], {
          // `detached`, exactly as the runner spawns a task: killTree
          // signals the process GROUP, so a child that is not its own group
          // leader is never reached and the sweep proves nothing.
          detached: true,
          stdout: 'ignore',
          stderr: 'ignore',
        })
      const first = spawnStubborn()
      const late = spawnStubborn()
      let sweep = 0
      // Sweep 1 sees only `first`; by the SIGKILL sweep, `late` has joined.
      const live = (): ReturnType<typeof Bun.spawn>[] => (++sweep === 1 ? [first] : [first, late])
      try {
        await terminateChildren(live, 'SIGTERM', 100)
        expect(sweep).toBeGreaterThan(1)
        expect(isAlive(first.pid)).toBe(false)
        expect(isAlive(late.pid)).toBe(false)
      } finally {
        for (const c of [first, late]) {
          try {
            c.kill('SIGKILL')
          } catch {
            // already gone
          }
        }
      }
    },
    TIMEOUT,
  )
})

describe("run()'s finally block (in-process)", () => {
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
    'the abort listener leaves with the run: one signal over many runs never stacks',
    async () => {
      // `vx watch` hands one `stop` signal to every cycle. A listener each
      // cycle left behind is a closure over that cycle's children, kept
      // for the life of the watch. Deleting the finally's
      // removeEventListener survived the whole core suite (item 635).
      const controller = new AbortController()
      const before = getEventListeners(controller.signal, 'abort').length
      for (let i = 0; i < 2; i++) {
        const r = await run({
          cwd: fixture.root,
          tasks: ['hello'],
          projects: ['app'],
          log: silentLogger,
          handleSignals: false,
          signal: controller.signal,
        })
        expect(r.ok).toBe(true)
        expect(getEventListeners(controller.signal, 'abort').length).toBe(before)
      }
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
