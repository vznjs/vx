// A task dies with everything it forked (item 236). Each task child is
// spawned into its own session and process group, and every kill — a
// timeout, a Ctrl-C, a hang-up — signals the group: the shell, what it
// backgrounded, a runner's workers. Before, only the direct child was
// signalled, and `sh -c "server & wait"` left the server alive under
// init after every timeout and every Ctrl-C.
//
// The `timed` task's timeout is a claim about time: the test reads the
// grandchild's pid and checks it is alive BEFORE the timeout reaps it, so
// the window must outlast a shell's fork on a loaded runner. At 300 ms a
// macOS runner reaped the grandchild before the check ran (2026-09-16,
// one run in about twenty); two seconds is the shortest round window no
// runner has outrun, and the reap itself is still proved by `waitForDead`.
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

// The grandchild writes its own pid before sleeping (single quotes: the
// outer shell must not expand `$$` to ITS pid, which dies with the direct
// child either way and proves nothing); the task then sleeps in the
// foreground. `timeout` fires on the `timed` task; the
// other two are ended by the signal the test sends to vx.
const CONFIG = `
  export default {
    tasks: {
      timed: {
        exec: { command: "sh -c 'echo $$ > gc.pid; exec sleep 60' & sleep 60", timeout: 2000 },
      },
      forever: {
        exec: { command: "sh -c 'echo $$ > gc.pid; exec sleep 60' & sleep 60" },
      },
      timedTrap: {
        exec: {
          command: "sh -c 'trap \\"\\" TERM; echo $$ > gc.pid; exec sleep 60' & sleep 60",
          timeout: 2000,
        },
      },
      graceful: {
        exec: {
          command: "sh -c 'trap \\"sleep 0.3; echo done > cleanup.txt; exit 0\\" TERM; echo $$ > gc.pid; while :; do sleep 0.05; done' & sleep 60",
        },
      },
      backend: {
        exec: {
          command: "sh -c 'trap \\"\\" TERM; echo $$ > gc.pid; echo READY; exec sleep 60' & wait",
          persistent: { readyWhen: 'READY' },
        },
      },
      e2e: { dependsOn: ['backend'], exec: { command: 'echo e2e-done' } },
    },
  }
`

async function grandchildPid(root: string): Promise<number> {
  const marker = path.join(root, 'packages', 'app', 'gc.pid')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const pid = Number.parseInt(readFileSync(marker, 'utf8'), 10)
      if (pid > 0) return pid
    }
    await Bun.sleep(20)
  }
  throw new Error('the task never wrote its grandchild pid')
}

function spawnVx(root: string, task: string, graceMs = 200): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, BIN, 'run', task, '--all'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', VX_KILL_GRACE_MS: String(graceMs) },
  })
}

describe('a task dies with everything it forked', () => {
  let root: string
  let leaked: number[] = []
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-tree-kill-' })
    await addProject(root, 'app', { config: CONFIG, files: { 'src/index.js': 'export {}\n' } })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    leaked = []
  })
  afterEach(async () => {
    // Never leave a 60 s sleeper behind when an assertion fails.
    for (const pid of leaked) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a timeout reaps the grandchild',
    async () => {
      const proc = spawnVx(root, 'timed')
      const gc = await grandchildPid(root)
      leaked.push(gc)
      expect(isAlive(gc)).toBe(true)
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ])
      expect(code).toBe(1)
      expect(out + err).toContain('timed out after 2000ms')
      expect(await waitForDead(gc, 3000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a timeout reaps a grandchild that ignores SIGTERM',
    async () => {
      // The shell dies on the timeout's SIGTERM; the grandchild ignores it.
      // The SIGKILL escalation was cleared with the shell's exit, so vx
      // exited 1 and the grandchild ran on under init (nx#11782's sibling,
      // reproduced on vx 2026-09-24).
      const proc = spawnVx(root, 'timedTrap')
      const gc = await grandchildPid(root)
      leaked.push(gc)
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ])
      expect(code).toBe(1)
      expect(out + err).toContain('timed out after 2000ms')
      expect(await waitForDead(gc, 1000)).toBe(true)
    },
    TIMEOUT,
  )

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    it(
      `${signal} to vx reaps the grandchild and exits ${code}`,
      async () => {
        const proc = spawnVx(root, 'forever')
        const gc = await grandchildPid(root)
        leaked.push(gc)
        expect(isAlive(gc)).toBe(true)
        // To the pid alone, as a terminal or `kill` sends it — never to a
        // group the grandchild might share with vx.
        process.kill(proc.pid, signal)
        expect(await proc.exited).toBe(code)
        expect(await waitForDead(gc, 3000)).toBe(true)
      },
      TIMEOUT,
    )
  }

  it(
    "a persistent dependency's server that ignores SIGTERM does not hang vx's exit",
    async () => {
      // `server & wait`: the shell dies on the end-of-run SIGTERM, the
      // server ignores it and holds the task's pipe. The shutdown waited
      // for the shell alone, never SIGKILLed the group, and vx printed its
      // summary and never exited (nx#8286 reproduced on vx, 2026-09-24).
      const proc = spawnVx(root, 'e2e')
      const gc = await grandchildPid(root)
      leaked.push(gc)
      const exit = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'hung' as const)])
      if (exit === 'hung') proc.kill('SIGKILL')
      expect(exit).toBe(0)
      expect(await waitForDead(gc, 1000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "a grandchild's SIGTERM cleanup gets the grace after its shell has exited",
    async () => {
      // The shell dies at once on the SIGTERM; the server it backgrounded
      // takes 0.3 s to clean up. The teardown ended the grace when the
      // shell exited and SIGKILLed the group mid-cleanup. The grace is
      // the group's: SIGKILL only past it, only for whoever is left.
      const proc = spawnVx(root, 'graceful', 5000)
      const gc = await grandchildPid(root)
      leaked.push(gc)
      const t0 = Date.now()
      process.kill(proc.pid, 'SIGTERM')
      expect(await proc.exited).toBe(143)
      expect(existsSync(path.join(root, 'packages', 'app', 'cleanup.txt'))).toBe(true)
      // And the wait ends when the group is gone, not at the grace. The
      // server dies an orphan, a zombie until init reaps it (1 to 2 s in a
      // container), and a group read that counted the zombie waited that
      // out: 1.5–2 s here against 0.32 s reading /proc (2026-09-24).
      expect(Date.now() - t0).toBeLessThan(1200)
      expect(await waitForDead(gc, 1000)).toBe(true)
    },
    TIMEOUT,
  )
})
