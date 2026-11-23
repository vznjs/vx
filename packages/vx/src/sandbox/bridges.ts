// A sandboxed task's network beside SRT's proxy: its own proxy front
// (`ownProxy`) and, on Linux, the socat bridges that expose its
// `localBinding` ports to the host and relay in the host loopback ports its
// `network` list names. Closed with the task (`closeTaskNet`).

import path from 'node:path'
import { readFileSync, unlinkSync } from 'node:fs'
import {
  shellQuote,
  type ResolvedSandboxConfig,
  killTree,
  releaseGroup,
  guardLine,
  spawnGuarded,
} from '../exec/index.js'
import { startTaskProxy, type TaskProxy } from './task-proxy.js'
import { executablePath, helperEnv, taskShell, procfsIsOwn } from '../util/index.js'
import type { SrtModule } from './session.js'
import { taskTmpdir, unlinkOnExit, liveTempFiles } from './tmp.js'
import { collecting } from './trace.js'

/** The ports a list grants, deduped; `true` bridges nothing (the host sees no port on Linux). */
export function bridgedPorts(c: Pick<ResolvedSandboxConfig, 'localBinding'>): number[] {
  return Array.isArray(c.localBinding) ? [...new Set(c.localBinding)] : []
}

/**
 * Linux: SRT starts its in-sandbox proxy bridges (`socat TCP-LISTEN:3128`
 * and `:1080`) in the background and runs the command at once, so a
 * networked task that dialled the proxy first met "connection refused"
 * (curl's `000`) on a loaded box (M-20). This waits, in front of the
 * command, until both listen in the task's network namespace, read off
 * /proc/net (IPv4 or IPv6, state 0A). Bounded at ~5 s: a bridge that never
 * listens leaves the command to meet the refusal it met before, and says
 * so on the task's stderr (it gave up in silence, 2026-11-10).
 *
 * Every task the run's bridge reaches waits, not only one that lists a
 * network: one that lists none dials the same proxy, which refuses and
 * names the host, and that refusal fails it. Waited for only by networked
 * tasks, it met the closed port instead under load, swallowed the error
 * and passed with nothing reported (2026-11-06). The wait costs ~4 ms, the
 * socat's own start.
 */
export const PROXY_BRIDGE_WAIT =
  "( i=0; until grep -qsE ':0C38 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6 && grep -qsE ':0438 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6; do [ $i -ge 500 ] && { echo \"[vx] the sandbox's network proxy bridges (ports 3128 and 1080) did not listen within 5 s; this task's network requests will be refused\" >&2; break; }; i=$((i+1)); sleep 0.01; done );"

/** Each networked task's own proxy front, by tag, closed when its bridges go. */
const taskProxies = new Map<string, TaskProxy>()

/**
 * A networked task's own proxy front (task-proxy.ts). The runtime's proxy
 * is the run's and filters by the union of every task's lists, so a task
 * reached a host only another task of the run declared. The front judges
 * by this task's own lists and passes what it allows on to the run's
 * proxy. Linux: it listens on a socket in the task's tmpdir, bound over
 * the runtime's bridge socket, so the task's side dials the same path.
 * macOS: it listens on a loopback port of its own, and the task's proxy
 * variables and profile name that port in place of the run's, so the
 * profile refuses the run's. A task that lists no network gets a front
 * that refuses every host; `network: true` gets one that allows the
 * run's union. Each front refuses only its own task's denies. Fails closed: a task the front cannot take does not run.
 */
export async function ownProxy(
  SandboxManager: SrtModule['SandboxManager'],
  wrapped: string,
  inner: string,
  tag: string,
  config: ResolvedSandboxConfig,
  /** The run's union: what a `network: true` task's front allows. */
  union: readonly string[],
): Promise<string> {
  const port = SandboxManager.getProxyPort()
  const token = SandboxManager.getProxyAuthToken()
  const linux = process.platform === 'linux'
  const bridge = linux ? SandboxManager.getLinuxHttpSocketPath() : undefined
  const bind = bridge === undefined ? undefined : `--bind ${bridge} ${bridge}`
  const runPort = new RegExp(`localhost:${port}(?!\\d)`, 'g')
  const handed =
    port !== undefined &&
    token !== undefined &&
    (linux ? bind !== undefined && wrapped.includes(bind) : runPort.test(wrapped))
  // A task that lists no network is handed the run's proxy too when another
  // task of the run lists some; it gets a front that refuses every host.
  if (!handed) {
    if (config.network === undefined) return wrapped
    throw new Error('sandbox: the runtime gave this networked task no proxy to replace')
  }
  const socket = path.join(taskTmpdir(tag), 'vx-net.sock')
  const key = Buffer.from(inner.slice(0, 100)).toString('base64')
  const front = await startTaskProxy({
    endpoint: linux ? socket : 0,
    allowed:
      config.network === true
        ? union
        : config.network === undefined
          ? []
          : (config.network as string[]),
    denied: config.denyNetwork ?? [],
    runProxyPort: port!,
    token: token!,
    encodedCommand: key,
    refused: (line) => collecting.get(key)?.push({ line, timestamp: new Date() }),
  })
  taskProxies.set(tag, front)
  if (!linux) return wrapped.replace(runPort, `localhost:${front.port}`)
  // After the root's read-only bind, which would mask a bind made before it
  // with the host's own file: the runtime's socket, reachable as itself.
  const own = `--bind ${socket} ${bridge}`
  const root = ' --ro-bind / / '
  const at = wrapped.indexOf(root)
  return at === -1
    ? wrapped.replace(bind!, own)
    : `${wrapped.slice(0, at + root.length)}${own} ${wrapped.slice(at + root.length)}`
}

/** Where a bridge's unix socket lives: the sandbox tmpdir, bound read-write on both sides. */
export function portBridgeSocket(tag: string, port: number): string {
  return path.join(taskTmpdir(tag), `vx-port-${tag}-${port}.sock`)
}

/**
 * Which loopback a bridged connection dials, chosen per connection from
 * the namespace's listen tables (`$1` the port, `$2` the tables' directory):
 * `::1` when only it holds the port, else 127.0.0.1. A server bound to
 * `localhost` on a host that resolves `::1` first (Vite's default) listens
 * on `::1` alone, and a fixed 127.0.0.1 dial was refused. Read before any
 * byte moves, so a connection is never retried halfway through.
 */
export const PORT_DIAL_SCRIPT = `p=$1 n=\${2:-/proc/net}
h=$(printf %04X "$p")
if grep -qsE "^ *[0-9]+: 0{24}01000000:$h [0-9A-F]+:0{4} 0A" "$n/tcp6" &&
  ! grep -qsE "^ *[0-9]+: (0100007F|0{8}):$h [0-9A-F]+:0{4} 0A" "$n/tcp"; then
  exec socat - "TCP6:[::1]:$p"
fi
exec socat - "TCP4:127.0.0.1:$p"
`

/** Where the dial script lives: beside the bridge's sockets, written by `wrapSandboxedCommand`. */
export function portDialScript(tag: string): string {
  return path.join(taskTmpdir(tag), `vx-port-dial-${tag}.sh`)
}

/**
 * The task's side of the bridge, in front of the user command inside the
 * sandbox: one socat per port, listening on the unix socket and relaying
 * into the namespace's loopback through `PORT_DIAL_SCRIPT`. Backgrounded
 * and reaped with the shell, exactly as SRT starts its own proxy bridges.
 * `unlink-early` clears a socket a killed task left behind; `>/dev/null`
 * keeps its chatter out of the task's frame.
 */
export function portBridgeInner(ports: readonly number[], tag: string): string {
  const cmds = ports.map(
    (p) =>
      `socat UNIX-LISTEN:${shellQuote(portBridgeSocket(tag, p))},fork,unlink-early ${shellQuote(`SYSTEM:sh ${portDialScript(tag)} ${p}`)} >/dev/null 2>&1 &`,
  )
  return `${cmds.join(' ')} trap 'kill $(jobs -p) 2>/dev/null' EXIT;`
}

/**
 * The host's side: one socat per port, listening on the host's loopback
 * and connecting into the unix socket per client — with a retry, since a
 * client can arrive before the task's side has bound the socket.
 */
export function portBridgeHostArgv(tag: string, port: number): string[] {
  return [
    'socat',
    `TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr`,
    `UNIX-CONNECT:${portBridgeSocket(tag, port)},retry=40,interval=0.25`,
  ]
}

/** Where a reached port's unix socket lives: beside the bridge's, in the sandbox tmpdir. */
function reachBridgeSocket(tag: string, port: number): string {
  return path.join(taskTmpdir(tag), `vx-reach-${tag}-${port}.sock`)
}

/** A port as `/proc/net/tcp` spells it: four uppercase hex digits. */
function procNetPort(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * The task's side of a reached loopback port (`network: ['localhost:4173']`),
 * in front of the user command: a listener on the port in the task's own
 * namespace (127.0.0.1, and ::1 where the host has IPv6: a client that
 * resolves `localhost` to ::1 first is refused there otherwise), relaying
 * each connection to the unix socket the host's side holds, with a retry
 * as the host's side of a port bridge has. Then a wait, bounded at ~5 s
 * as `PROXY_BRIDGE_WAIT`'s, until each listens: the client dials at once.
 */
export function reachBridgeInner(ports: readonly number[], tag: string, ipv6: boolean): string {
  const listens = ports.flatMap((p) => {
    const to = shellQuote(`UNIX-CONNECT:${reachBridgeSocket(tag, p)},retry=40,interval=0.25`)
    return [
      `socat TCP4-LISTEN:${p},bind=127.0.0.1,fork,reuseaddr ${to} >/dev/null 2>&1 &`,
      ...(ipv6
        ? [`socat TCP6-LISTEN:${p},bind=[::1],ipv6only=1,fork,reuseaddr ${to} >/dev/null 2>&1 &`]
        : []),
    ]
  })
  const waits = ports.map(
    (p) =>
      `( i=0; until grep -qsE ':${procNetPort(p)} [0-9A-F]+:0000 0A' /proc/net/tcp; do [ $i -ge 500 ] && break; i=$((i+1)); sleep 0.01; done );`,
  )
  return `${listens.join(' ')} trap 'kill $(jobs -p) 2>/dev/null' EXIT; ${waits.join(' ')}`
}

/**
 * The host's side of a reached port: a unix socket in the task's tmpdir,
 * dialling the host's loopback per connection through `PORT_DIAL_SCRIPT`
 * (::1 when only it holds the port: Vite's `localhost`).
 */
function reachBridgeHostArgv(tag: string, port: number): string[] {
  return [
    'socat',
    `UNIX-LISTEN:${reachBridgeSocket(tag, port)},fork,unlink-early`,
    `SYSTEM:sh ${portDialScript(tag)} ${port}`,
  ]
}

export const hostBridges = new Map<
  string,
  {
    ports: readonly number[]
    /** The host loopback ports the task reaches (`reachBridgeInner`). */
    reach: readonly number[]
    procs: Array<ReturnType<typeof Bun.spawn>>
  }
>()

/**
 * The released bridges still on their way out, by the port each holds
 * until it has gone. A release ends a bridge by signal, and the next wrap
 * of its port (the task after it, a watch re-run, the retry of an attempt
 * the observer ended) read the dying socat in the table as another
 * process's listener and refused the task (2026-11-18).
 */
const leavingBridges = new Map<number, Set<Promise<unknown>>>()

/** Wait, 5 s at most, for this process's released bridges to let the ports go. */
export async function bridgesGone(ports: readonly number[]): Promise<void> {
  const leaving = ports.flatMap((p) => [...(leavingBridges.get(p) ?? [])])
  if (leaving.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(leaving),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 5_000)
    }),
  ])
  clearTimeout(timer)
}

/**
 * The ports a host listener already holds where the bridge would bind
 * (`127.0.0.1`, or every address). The listen wait below reads the same
 * table and took that listener for the bridge, whose bind had failed: the
 * task passed and a client of the port reached the other process
 * (2026-10-03). Linux, own procfs only, as the wait.
 */
export function portsHeld(ports: readonly number[]): number[] {
  if (ports.length === 0) return []
  // This run's own bridges first: a wrap claims its ports before it awaits,
  // and two tasks granted one port both read the table before either
  // bridge bound, so the second's bind failed unseen and its clients
  // reached the first task.
  const claimed = new Set([...hostBridges.values()].flatMap((b) => b.ports))
  const ours = ports.filter((p) => claimed.has(p))
  if (ours.length > 0 || !procfsIsOwn()) return ours
  const held = new Set<string>()
  for (const [file, any, loop] of [
    ['/proc/net/tcp', '00000000', '0100007F'],
    ['/proc/net/tcp6', '00000000000000000000000000000000', '00000000000000000000000001000000'],
  ] as const) {
    let table: string
    try {
      table = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[3] !== '0A' || f[1] === undefined) continue
      const [addr, port] = f[1].split(':')
      // `::1` does not hold 127.0.0.1's port; every address does.
      if (addr === any || (file === '/proc/net/tcp' && addr === loop)) held.add(port!)
    }
  }
  return ports.filter((p) => held.has(procNetPort(p)))
}

/**
 * Wait until each host-side bridge listens on its port, so a server that
 * says it is ready inside the sandbox is reachable on the host: the socat
 * starts asynchronously, and a held server's port refused a connection
 * right after its ready line under I/O load (M-22). Read off
 * /proc/net/tcp (127.0.0.1, state 0A); skipped where /proc is not this
 * process's (its net table could be another namespace's), ended early by
 * a bridge that exited, and bounded at 5 s. A port another listener holds
 * reads as listening here, so the wrap refuses it first (`portsHeld`).
 */
export async function hostBridgesListen(ports: readonly number[], tag: string): Promise<void> {
  if (!procfsIsOwn()) return
  const want = ports.map((p) => `0100007F:${procNetPort(p)}`)
  const procs = hostBridges.get(tag)?.procs ?? []
  const until = performance.now() + 5_000
  while (performance.now() < until && procs.every((p) => p.exitCode === null)) {
    let table: string
    try {
      table = readFileSync('/proc/net/tcp', 'utf8')
    } catch {
      return
    }
    const listening = new Set<string>()
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[3] === '0A' && f[1] !== undefined) listening.add(f[1])
    }
    if (want.every((w) => listening.has(w))) return
    await Bun.sleep(5)
  }
}

export function spawnHostBridges(tag: string): void {
  const { ports, reach, procs } = hostBridges.get(tag)!
  const argvs = [
    ...ports.map((p) => portBridgeHostArgv(tag, p)),
    ...reach.map((p) => reachBridgeHostArgv(tag, p)),
  ]
  for (const bridge of argvs) {
    // A spawn failure (no socat on the host) is the task's to report:
    // its own side dies the same way, in its frame.
    try {
      // socat resolved on vx's PATH, as every tool vx spawns: by bare name
      // Bun.spawn walked the startup PATH (M-22).
      const [tool, ...rest] = bridge
      const argv = [executablePath(tool!), ...rest]
      // Guarded, in a group of its own (kill-tree.ts): a plain child of vx
      // was in no group the guard lists, and a `kill -9` of vx left it
      // listening on the port under init, where the next run's bridge
      // could not bind it (item 873).
      procs.push(
        spawnGuarded((guard) =>
          Bun.spawn(
            guard === undefined
              ? argv
              : [taskShell(), '-c', `${guardLine(3)}exec ${argv.map(shellQuote).join(' ')}`],
            {
              stdio: ['ignore', 'ignore', 'ignore', ...(guard === undefined ? [] : [guard])],
              detached: true,
              env: helperEnv(),
            },
          ),
        ),
      )
    } catch {
      // see above
    }
  }
  if (procs.length > 0) {
    for (const p of ports) unlinkOnExit(portBridgeSocket(tag, p))
    for (const p of reach) unlinkOnExit(reachBridgeSocket(tag, p))
  }
}

/** Close a task's proxy front and stop the host side of its port bridges, removing their sockets; idempotent. */
export function closeTaskNet(tag: string): void {
  const front = taskProxies.get(tag)
  if (front !== undefined) {
    taskProxies.delete(tag)
    // quiet: a front that will not close holds only its own socket, gone with the tmpdir
    void front.close().catch(() => undefined)
  }
  const bridges = hostBridges.get(tag)
  if (bridges === undefined) return
  hostBridges.delete(tag)
  for (const sock of [
    ...bridges.ports.map((p) => portBridgeSocket(tag, p)),
    ...bridges.reach.map((p) => reachBridgeSocket(tag, p)),
  ]) {
    try {
      unlinkSync(sock)
    } catch {
      // never bound, or gone
    }
    liveTempFiles.delete(sock)
  }
  for (const [i, p] of bridges.procs.entries()) {
    // The group: a socat forks one child per connection. Listed on the
    // guard until it has gone (item 867's order).
    killTree(p, 'SIGTERM')
    const gone = p.exited.then(() => releaseGroup(p))
    // `spawnHostBridges` spawns the ports' bridges first, in order.
    const port =
      bridges.procs.length === bridges.ports.length + bridges.reach.length
        ? bridges.ports[i]
        : undefined
    if (port === undefined || p.exitCode !== null) continue
    const leaving = leavingBridges.get(port) ?? new Set()
    leavingBridges.set(port, leaving)
    leaving.add(gone)
    void gone.then(() => {
      leaving.delete(gone)
      if (leaving.size === 0) leavingBridges.delete(port)
    })
  }
}
