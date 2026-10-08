// A `kill -9` of vx leaves the sandbox runtime's own session behind
// unless the group guard takes it (kill-tree.md). The runtime spawns its
// network bridge, a socat on `claude-http-<hex>.sock`, as a plain child
// in vx's own group, which the guard never lists; it ran on under init
// with its socket, and the `srt-obs-*` and `srt-mux-*` sockets vx itself
// listened on stayed in the temp directory. Dozens piled up on a dev box.
// Unsafe: it spawns vx with a sandboxed task and reads the host's procfs.

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { isAlive, waitForDead } from './helpers/alive.js'

const TIMEOUT = 60_000
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox session guard tests')

const pids = (): string[] => readdirSync('/proc').filter((d) => /^\d+$/.test(d))

/** The host pid running `sleep <arg>`: the pid namespace hides the task's own. */
const sleeper = (arg: string): number | undefined =>
  pids()
    .map(Number)
    .find((d) => {
      try {
        return readFileSync(`/proc/${d}/cmdline`, 'utf8') === `sleep\0${arg}\0`
      } catch {
        return false
      }
    })

/** Children of `parent` whose command line is the runtime's bridge socat. */
function bridges(parent: number): { pid: number; socket: string }[] {
  const found: { pid: number; socket: string }[] = []
  for (const d of pids()) {
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== parent) continue
      const m = /UNIX-LISTEN:([^,\0]*claude-(?:http|socks)-[0-9a-f]+\.sock),/.exec(
        readFileSync(`/proc/${d}/cmdline`, 'utf8'),
      )
      if (m) found.push({ pid: Number(d), socket: m[1]! })
    } catch {
      // gone
    }
  }
  return found
}

/** The unix sockets `pid` holds that the runtime named (`srt-*`). */
function runtimeSockets(pid: number): string[] {
  const inodes = new Set<string>()
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const link = readlinkSync(`/proc/${pid}/fd/${fd}`)
      if (link.startsWith('socket:[')) inodes.add(link.slice(8, -1))
    } catch {
      // closed
    }
  }
  return readFileSync('/proc/net/unix', 'utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 8 && inodes.has(f[6]!) && /\/srt-/.test(f[7]!))
    .map((f) => f[7]!)
}

describe.skipIf(!available || process.platform !== 'linux')(
  'a SIGKILLed vx takes the sandbox runtime’s session with it',
  () => {
    let root = ''
    beforeEach(async () => {
      root = await makeWorkspace({ prefix: 'vx-srt-guard-' })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it(
      'its bridge socat dies, and its sockets and observer directory are removed',
      async () => {
        const nonce = `${1000 + Math.floor(Math.random() * 1000)}.${process.pid}`
        await addProject(
          root,
          'app',
          `
            export default {
              tasks: {
                dev: {
                  exec: {
                    command: 'echo READY; exec sleep ${nonce}',
                    persistent: { readyWhen: 'READY' },
                    sandbox: {},
                  },
                },
              },
            }
          `,
        )
        const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
          cwd: root,
          env: { ...process.env },
          stdout: 'ignore',
          stderr: 'ignore',
        })
        let sleeperPid: number | undefined
        let socats: { pid: number; socket: string }[] = []
        let held: string[] = []
        let existed = false
        try {
          const deadline = Date.now() + 20_000
          // The task runs once the session is up and listed.
          while (sleeper(nonce) === undefined && Date.now() < deadline) await Bun.sleep(20)
          sleeperPid = sleeper(nonce)
          socats = bridges(proc.pid)
          held = runtimeSockets(proc.pid)
          // Checked while vx lives: once it dies the guard may remove them
          // before this test looks.
          existed = [...socats.map((s) => s.socket), ...held].every((p) => existsSync(p))
        } finally {
          process.kill(proc.pid, 'SIGKILL')
        }
        expect(await proc.exited).toBe(137)
        // The positives first: the session was up while vx ran.
        expect(sleeperPid).toBeDefined()
        expect(socats.length).toBeGreaterThan(0)
        const obs = held.filter((p) => path.basename(path.dirname(p)).startsWith('srt-obs-'))
        const mux = held.filter((p) => path.basename(p).startsWith('srt-mux-'))
        expect(obs).toHaveLength(1)
        expect(mux).toHaveLength(1)
        const paths = [...new Set([...socats.map((s) => s.socket), path.dirname(obs[0]!), ...mux])]
        expect(existed).toBe(true)

        await Promise.all(socats.map((s) => waitForDead(s.pid, 3_000)))
        const until = Date.now() + 3_000
        while (paths.some((p) => existsSync(p)) && Date.now() < until) await Bun.sleep(20)
        const alive = socats.filter((s) => isAlive(s.pid)).map((s) => s.pid)
        const left = paths.filter((p) => existsSync(p))
        // Leave nothing behind for the rest of the suite.
        for (const pid of alive) process.kill(pid, 'SIGKILL')
        for (const p of left) await rm(p, { recursive: true, force: true })
        expect({ alive, left }).toEqual({
          alive: [],
          left: [],
        })
      },
      TIMEOUT,
    )
  },
)
