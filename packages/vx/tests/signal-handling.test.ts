// SIGINT/SIGTERM during `run()`: every live child (one-shot AND
// persistent) gets SIGTERM, a survivor is SIGKILLed after the grace, the
// cache handle closes, and vx exits with 128+signo (130/143). The e2e tests spawn the real CLI as a
// subprocess because signal delivery + process exit can't be
// asserted in-process; the listener-leak test runs in-process
// because that's exactly where stacking handlers would hurt
// (watch loop, bun test).

import { getEventListeners } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { describePid, isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { terminateChildren } from '../src/orchestrator/signals.js'

// The SIGTERM→SIGKILL grace is 2 s by default; every test here that proves
// the escalation would wait it out. 200 ms proves the same claim
// (`VX_KILL_GRACE_MS`, see util/settle.ts). Each spawn passes it in `env`:
// `Bun.spawn` without one hands the child the process's STARTUP
// environment, not `process.env` as written since (Bun 1.4.2), so until
// item 849 every vx here ran on the 2 s default.
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
        env: { ...process.env },
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

  // A signal exit is `process.exit`, which runs no finally, so the run
  // lock's entry stayed in the temp dir for the next run to reclaim (item
  // 848). Since item 849 a first signal lets run() leave through its
  // finally, which releases the lock; the second signal is the immediate
  // exit, and there only the exit hook removes the entry. It is sent once
  // the task has heard the first: two signals sent back to back can land
  // as one, and the row then never reached the second (item 862).
  const leavesNoLock = (signals: number) => async () => {
    await addProject(
      fixture.root,
      'app',
      `export default { tasks: { slow: { exec: { command: "trap 'echo int > int.txt' INT; echo up > up.txt; while :; do sleep 0.05; done" } } } }`,
    )
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-sig-tmp-'))
    try {
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: tmp },
      })
      const up = path.join(fixture.root, 'packages', 'app', 'up.txt')
      const deadline = Date.now() + 10_000
      while (!existsSync(up) && Date.now() < deadline) await Bun.sleep(20)
      // The positive first: the running vx holds an entry here.
      const locks = readdirSync(tmp).filter((n) => n.startsWith('vx-run-'))
      expect(locks.length).toBe(1)
      expect(readdirSync(path.join(tmp, locks[0]!))).toEqual([
        expect.stringMatching(new RegExp(`^h-${proc.pid}-`)),
      ])
      proc.kill('SIGINT')
      if (signals === 2) {
        const heard = path.join(fixture.root, 'packages', 'app', 'int.txt')
        const until = Date.now() + 10_000
        while (!existsSync(heard) && Date.now() < until) await Bun.sleep(20)
        expect(existsSync(heard)).toBe(true)
        proc.kill('SIGINT')
      }
      expect(await proc.exited).toBe(130)
      expect(readdirSync(tmp).filter((n) => n.startsWith('vx-run-'))).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  it('a signal exit leaves no run-lock entry behind', leavesNoLock(1), TIMEOUT)
  it('a second signal exit leaves no run-lock entry behind', leavesNoLock(2), TIMEOUT)

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
        env: { ...process.env },
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
        env: { ...process.env },
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
                exec: { command: "trap '' INT TERM; echo $$ > pid.txt; exec sleep 30" },
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
                exec: { command: "trap '' INT TERM; echo $$ > pid.txt; exec sleep 30" },
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
        env: { ...process.env },
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
  // One row per signal and task kind, each title a literal: the
  // upstream ledger (docs/upstream-ledger.md) cites them by their text.
  const reaches = (signal: 'SIGINT' | 'SIGTERM', code: number, persistent: boolean) => async () => {
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
    // The trap is the subject, not the escalation: at the file's 200 ms a
    // loaded macOS runner SIGKILLed the shell before its trap wrote got.txt
    // (PR #929). vx exits when the child does, so a long grace costs nothing.
    const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
      cwd: fixture.root,
      env: { ...process.env, VX_KILL_GRACE_MS: '5000' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    proc.kill(signal)
    expect(await proc.exited).toBe(code)
    expect((await Bun.file(path.join(dir, 'got.txt')).text()).trim()).toBe(signal)
    expect(await waitForDead(pid, 3_000)).toBe(true)
  }

  // The foreground keep-alive names the server that ended the session and
  // its code. Once a stop let run() finish its own path (item 849), every
  // Ctrl-C of a dev server printed "exited with code 130" as if it had
  // crashed (item 852). The control: a server that ends on its own is named.
  it(
    'a Ctrl-C of a foreground server does not report it as exited; a server that exits is',
    async () => {
      const out = async (command: string, signal: boolean): Promise<string> => {
        await addProject(
          fixture.root,
          'app',
          `export default { tasks: { dev: { exec: {
            command: ${JSON.stringify(command)},
            persistent: { readyWhen: 'READY' },
          } } } }`,
        )
        const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
          cwd: fixture.root,
          env: { ...process.env },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const text = Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        if (signal) {
          await waitForPid(path.join(fixture.root, 'packages', 'app', 'pid.txt'), 10_000)
          proc.kill('SIGINT')
        }
        await proc.exited
        return (await text).join('')
      }
      expect(await out('echo READY; sleep 0.3; exit 3', false)).toContain(
        'vx: app#dev exited with code 3',
      )
      expect(await out('echo $$ > pid.txt; echo READY; exec sleep 30', true)).not.toContain(
        'exited with code',
      )
    },
    TIMEOUT,
  )

  // What a task prints while it stops reaches the terminal, 2 MiB of it,
  // then the summary. Before item 849 the handler exited on the kill and the
  // frame never printed; after it, a CI-mode run lost 0.8 of the 2 MiB to
  // `process.exit`, because the drain's empty write called back before the
  // pipe took the bytes (item 857). The reader starts only after vx has
  // exited, so the pipe is full when the exit lands.
  it(
    'a Ctrl-C exit loses none of what the run wrote',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `export default { tasks: { big: { exec: {
        command: "trap 'yes | head -c 2097152; echo END-OF-BIG; exit 0' INT; echo $$ > pid.txt; while :; do sleep 0.05; done",
      } } } }`,
      )
      // Focused, so the task's own output is printed (a broad run shows news).
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'app#big'], {
        cwd: fixture.root,
        // CI mode is where the empty write lost the tail.
        env: { ...process.env, VX_KILL_GRACE_MS: '5000', CI: 'true' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      proc.kill('SIGINT')
      expect(await proc.exited).toBe(130)
      const out = await new Response(proc.stdout).text()
      // On a line of its own: the frame's header echoes the command too.
      expect(out).toContain('\nEND-OF-BIG\n')
      expect(out.trimEnd().split('\n').at(-1)).toMatch(/^ *time /)
    },
    TIMEOUT,
  )

  // A Ctrl-C'd run records no history: since item 849 the stopped run
  // finishes its own path, and it landed in `vx last` as FAILED with 0
  // tasks, hiding the run the user wanted to look at (item 854).
  it(
    'a Ctrl-C leaves the history as it was',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `export default { tasks: {
        quick: { exec: { command: 'true' } },
        slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } },
      } }`,
      )
      const vx = (...args: string[]) =>
        Bun.spawn([process.execPath, BIN, ...args], {
          cwd: fixture.root,
          env: { ...process.env },
          stdout: 'pipe',
          stderr: 'pipe',
        })
      const list = async (): Promise<string[]> => {
        const p = vx('last', '--list')
        const out = await new Response(p.stdout).text()
        await p.exited
        return out
          .trim()
          .split('\n')
          .map((l) => l.split(/\s+/)[0]!)
      }
      expect(await vx('run', 'quick', '--all').exited).toBe(0)
      expect(await list()).toEqual(['ok'])
      const proc = vx('run', 'slow', '--all')
      await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      proc.kill('SIGINT')
      expect(await proc.exited).toBe(130)
      expect(await list()).toEqual(['ok'])
    },
    TIMEOUT,
  )

  it('SIGINT to vx reaches a one-shot task as SIGINT', reaches('SIGINT', 130, false), TIMEOUT)
  it(
    'SIGINT to vx reaches a ready persistent task as SIGINT',
    reaches('SIGINT', 130, true),
    TIMEOUT,
  )
  it('SIGTERM to vx reaches a one-shot task as SIGTERM', reaches('SIGTERM', 143, false), TIMEOUT)
  it(
    'SIGTERM to vx reaches a ready persistent task as SIGTERM',
    reaches('SIGTERM', 143, true),
    TIMEOUT,
  )

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
        env: { ...process.env },
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

  // turborepo#14043: the runner exited while its tasks were still shutting
  // down, and their output landed on the terminal after the prompt. The
  // rows above wait for the children AFTER vx exits, so a vx that left
  // early would pass them; this one asks at the moment of exit.
  it(
    'at the moment vx exits on a signal every task process is gone and its pipes are closed',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo $$ > dev.pid; echo READY; exec sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
              slow: {
                exec: {
                  command: "trap 'sleep 0.5; printf LATE-%s OUTPUT; exit 0' TERM; sleep 30 & echo $! > child.pid; echo $$ > slow.pid; wait",
                },
              },
            },
          }
        `,
      )
      for (const [signal, expected] of [
        ['SIGTERM', 143],
        ['SIGINT', 130],
      ] as const) {
        for (const f of ['dev.pid', 'slow.pid', 'child.pid']) {
          await rm(path.join(dir, f), { force: true })
        }
        const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', 'slow', '--all'], {
          cwd: fixture.root,
          env: { ...process.env },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const streams = Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const pids = await Promise.all(
          ['dev.pid', 'slow.pid', 'child.pid'].map((f) => waitForPid(path.join(dir, f), 10_000)),
        )
        proc.kill(signal)
        const code = await proc.exited
        // Named by the file each pid came from, so a failure says WHICH
        // process outlived vx (it went red once under a full gate's load,
        // STATUS Next 23), and in what state.
        const aliveAt = pids.flatMap((p, i) =>
          isAlive(p) ? [[`${['dev', 'slow', 'child'][i]}: ${describePid(p)}`, p] as const] : [],
        )
        // Under a sandbox's procfs a zombie reads as alive (helpers/alive.ts).
        // vx released every group before it exited, so its group guard kills
        // nothing now: a process that was alive and is gone within 3 s was a
        // zombie awaiting its reaper; one still here was a leak. The failure
        // says which (Next 23).
        const since = Date.now()
        while (aliveAt.some(([, p]) => isAlive(p)) && Date.now() - since < 3_000)
          await Bun.sleep(20)
        const alive = aliveAt.map(([what, p]) =>
          isAlive(p)
            ? `${what}, still alive 3 s after the exit`
            : `${what}, gone within ${Date.now() - since} ms`,
        )
        const closed = await Promise.race([streams, Bun.sleep(1_000).then(() => null)])
        expect({ signal, code, alive, closed: closed !== null }).toEqual({
          signal,
          code: expected,
          alive: [],
          closed: true,
        })
        // Spelled apart in the command: a failed task's frame echoes it.
        expect(closed!.join('')).not.toContain('LATE-OUTPUT')
      }
    },
    TIMEOUT,
  )

  // nx#33460, nx#32438: a continuous task's own child, trapping every
  // signal it could get, outlived Ctrl-C.
  it(
    'the child of a persistent task that traps TERM, INT and HUP is dead after SIGINT or SIGTERM to vx',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              frontend: {
                exec: {
                  command: "sh -c 'trap \\"\\" TERM INT HUP; echo $$ > server.pid; exec sleep 30' & echo READY; wait",
                  persistent: { readyWhen: 'READY' },
                },
              },
              hold: { exec: { command: 'sleep 30' }, dependsOn: ['frontend'] },
            },
          }
        `,
      )
      for (const [signal, expected] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
      ] as const) {
        await rm(path.join(dir, 'server.pid'), { force: true })
        const proc = Bun.spawn([process.execPath, BIN, 'run', 'hold', '--all'], {
          cwd: fixture.root,
          env: { ...process.env },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const server = await waitForPid(path.join(dir, 'server.pid'), 10_000)
        expect(isAlive(server)).toBe(true)
        proc.kill(signal)
        expect({ signal, code: await proc.exited }).toEqual({ signal, code: expected })
        expect(await waitForDead(server, 3_000)).toBe(true)
      }
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
