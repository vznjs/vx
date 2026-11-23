// A daemon that calls setsid leaves its task's process group, which is all a
// group signal reaches: a stopped dev server's daemon, or a Ctrl-C'd task's,
// ran on under init. Each spawn carries a token in its environment
// (`VX_RUN_TREE`) that every descendant inherits, so a stop finds them by it:
// /proc on Linux, `ps -E` on macOS. Unsafe: a sandboxed shard's /proc is
// another namespace's, where the scan would find nothing.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { killTree, untilGroupsGone } from '../src/exec/kill-tree.js'
import { runCommand, runPersistent } from '../src/exec/runner.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-kill-tree-escaped-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A daemon in a session of its own (Node's `detached` calls setsid), ignoring
// SIGTERM as a server mid-cleanup does, writing its pid once it runs.
const daemon = path.join(dir, 'daemon.sh')
writeFileSync(daemon, `trap '' TERM\necho $$ > "$1"\nwhile :; do sleep 1; done\n`)
const spawner = path.join(dir, 'spawn.cjs')
writeFileSync(
  spawner,
  `require('node:child_process').spawn('sh', [${JSON.stringify(daemon)}, process.argv[2]], { detached: true, stdio: 'ignore' }).unref()\n`,
)
const env = { PATH: process.env.PATH ?? '' }
let n = 0
const startDaemon = (): { pidFile: string; line: string } => {
  const pidFile = path.join(dir, `pid-${++n}`)
  return {
    pidFile,
    line: `${JSON.stringify(process.execPath)} ${JSON.stringify(spawner)} ${JSON.stringify(pidFile)}`,
  }
}

async function daemonPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 0) return pid
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error('the daemon never started')
    await Bun.sleep(10)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    // An orphan dead of the signal waits for init to reap it.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !'ZX'.includes(stat[stat.lastIndexOf(')') + 2]!)
  }
  const out = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)])
  return out.exitCode === 0 && !out.stdout.toString().trim().startsWith('Z')
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await Bun.sleep(20)
  }
  return true
}

const kill = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // gone
  }
}

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'a daemon that left the task group with setsid',
  () => {
    it('is stopped with the server that started it, past its SIGTERM trap', async () => {
      const d = startDaemon()
      const spawn = runPersistent({
        command: `${d.line} && echo ready && exec sleep 60`,
        cwd: dir,
        env,
        readyWhen: 'ready',
      })
      const child = spawn.child!
      let pid: number | undefined
      try {
        await spawn.ready
        pid = await daemonPid(d.pidFile)
        // The stop every server teardown runs (stopServer).
        killTree(child, 'SIGTERM')
        for (const c of await untilGroupsGone([child], 500)) killTree(c, 'SIGKILL')
        await child.exited
        expect(await goneWithin(pid, 5_000)).toBe(true)
      } finally {
        killTree(child, 'SIGKILL')
        if (pid !== undefined) kill(pid)
      }
    }, 30_000)

    it('is stopped with a task a Ctrl-C stops', async () => {
      const d = startDaemon()
      const live = new Set<ReturnType<typeof Bun.spawn>>()
      let pid: number | undefined
      try {
        const running = runCommand({
          command: `${d.line} && exec sleep 60`,
          cwd: dir,
          env,
          liveChildren: live,
        })
        pid = await daemonPid(d.pidFile)
        // The sweep a run's stop runs (terminateChildren).
        const children = [...live]
        for (const c of children) killTree(c, 'SIGINT')
        for (const c of await untilGroupsGone(children, 500)) killTree(c, 'SIGKILL')
        await running
        expect(await goneWithin(pid, 5_000)).toBe(true)
      } finally {
        if (pid !== undefined) kill(pid)
      }
    }, 30_000)

    // The run goes on past a timeout, and the daemon may serve a task still
    // running (sccache): only the task's group is stopped.
    it('outlives a task that timed out', async () => {
      const d = startDaemon()
      let pid: number | undefined
      try {
        const result = await runCommand({
          command: `${d.line} && exec sleep 60`,
          cwd: dir,
          env,
          timeoutMs: 1_000,
        })
        expect(result.timedOut).toBe(true)
        pid = await daemonPid(d.pidFile)
        await Bun.sleep(300)
        expect(alive(pid)).toBe(true)
      } finally {
        if (pid !== undefined) kill(pid)
      }
    }, 30_000)

    // A shared daemon a build starts (sccache, Gradle's) is the next build's:
    // a task that ends on its own leaves it running.
    it('outlives a task that ended on its own', async () => {
      const d = startDaemon()
      let pid: number | undefined
      try {
        const result = await runCommand({ command: d.line, cwd: dir, env })
        expect(result.exitCode).toBe(0)
        pid = await daemonPid(d.pidFile)
        await Bun.sleep(300)
        expect(alive(pid)).toBe(true)
      } finally {
        if (pid !== undefined) kill(pid)
      }
    }, 30_000)
  },
)
