// End-of-run disposition of persistent children (dev servers, watchers).
// `executeTask` spawns them and returns at "ready" without awaiting exit;
// ownership moves to the run's registry, and this is the one place that
// decides which of them outlive the graph and how the rest go down.

import { isGroupTask, isPassStatus, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { killGraceMs } from '../util/index.js'
import { holdGroups, killTree, signalExitCode, untilGroupsGone } from '../exec/index.js'
import type { HeldPersistent, HeldServer } from './options.js'
import { terminateChildren } from './signals.js'

type Child = ReturnType<typeof Bun.spawn>

/**
 * Grace after SIGTERMing the dependency-only persistent tasks before
 * force-killing any that trap or ignore it — so a wedged mock server can't
 * hang a normal run at completion. Well-behaved servers exit far under
 * this, so the happy path never waits it out.
 */
const PERSISTENT_SHUTDOWN_GRACE_MS = 2000

export interface KeepAlive {
  nodes: TaskNode[]
  children: Child[]
}

/**
 * A persistent task the user REQUESTED (or one surfaced for display) is the
 * run's whole purpose — it is left running and blocked on at the very end,
 * after the summary. So is every persistent task a requested group stands
 * for, and every one a kept one depends on, directly or through groups: `vx run dev --filter app` stopped the api#dev
 * its app#dev was started against (C-46). A one-shot's persistent deps are
 * not kept on its account; it has finished with them. Only in the real CLI
 * foreground: a custom logger or `handleSignals: false` (watch mode,
 * embedders) expects `run()` to return, not to sit on a server.
 */
export function selectKeepAlive(
  registry: ReadonlyMap<string, Child>,
  nodes: ReadonlyMap<string, TaskNode>,
  foreground: boolean,
): KeepAlive {
  const out: KeepAlive = { nodes: [], children: [] }
  if (!foreground || registry.size === 0) return out
  // A requested GROUP is a requested server's stand-in: `vx run app#dev`
  // over `dev: { dependsOn: ['^dev'] }` started every server and exited 0
  // at the end of the graph, stopping them all (C-52).
  const stack: string[] = []
  for (const [id, n] of nodes) {
    if (!n.requested && n.surfaced !== true) continue
    if (registry.has(id) || isGroupTask(n)) stack.push(id)
  }
  const reached = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      const d = nodes.get(dep)
      if (d !== undefined && (registry.has(dep) || isGroupTask(d))) stack.push(dep)
    }
  }
  for (const [id, child] of registry) {
    if (!reached.has(id)) continue
    out.nodes.push(nodes.get(id)!)
    out.children.push(child)
  }
  return out
}

/**
 * SIGTERM every persistent child not kept alive and wait for them, bounded:
 * SIGTERM gives well-behaved servers (vite, next, esbuild --watch) a moment
 * to clean up; past the grace every group with a member left is SIGKILLed,
 * so the run's normal completion cannot hang on one that traps the signal.
 * The GROUP, not the leader: a `server & wait` shell dies on the SIGTERM
 * while a server that ignores it lives on, holding the task's pipe, and
 * vx printed its summary and never exited (nx#8286 reproduced on vx,
 * 2026-09-24).
 */
export async function shutdownPersistent(
  registry: ReadonlyMap<string, Child>,
  keepAlive: readonly Child[],
  graceMs: number = killGraceMs(PERSISTENT_SHUTDOWN_GRACE_MS),
): Promise<CrashedPersistent[]> {
  const kept = new Set(keepAlive)
  const crashed: CrashedPersistent[] = []
  for (const [id, child] of registry) {
    if (kept.has(child) || !hasEnded(child) || child.exitCode === 0) continue
    crashed.push({ id, code: child.exitCode ?? child.signalCode ?? 'unknown' })
  }
  const dying = [...registry.values()].filter((c) => !kept.has(c))
  if (dying.length === 0) return crashed
  const letGo = holdGroups(dying)
  try {
    for (const child of dying) killTree(child, 'SIGTERM')
    for (const child of await untilGroupsGone(dying, graceMs)) killTree(child, 'SIGKILL')
    await Promise.allSettled(dying.map((c) => c.exited))
  } finally {
    letGo()
  }
  return crashed
}

/**
 * A dependency-only persistent task that ended on its own, not by the stop
 * at the end of the graph, and not cleanly. Its dependants may still have
 * passed, and until item 892 the run did too: the server was reported
 * `success` and its crash was said nowhere, while a requested server's
 * crash failed the run.
 */
export interface CrashedPersistent {
  id: string
  /** The exit code, or the signal that killed it. */
  code: number | string
}

/** The child has exited or been killed; Bun sets these once it reaps it. */
export function hasEnded(child: Child): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** A server's identity across watch cycles: its resolved config and the args forwarded to it. */
export function serverConfig(node: TaskNode, forwardArgs: readonly string[] | undefined): string {
  return JSON.stringify([node.config, forwardArgs ?? []])
}

/**
 * Split an earlier run's held servers into the ones this graph may keep
 * (still up, a node of this graph, same config) and the ones it stops. A
 * stopped one is handed over now, so the earlier run names no exit; a kept
 * one only when its task is reached, and one never reached (a dependency
 * failed) is the earlier run's to stop.
 */
export function takeHeldServers(
  held: ReadonlyMap<string, HeldServer> | undefined,
  nodes: ReadonlyMap<string, TaskNode>,
  forwardArgs: readonly string[] | undefined,
): { kept: Map<string, HeldServer>; stale: Child[] } {
  const kept = new Map<string, HeldServer>()
  const stale: Child[] = []
  for (const [id, server] of held ?? []) {
    if (hasEnded(server.child)) continue
    const node = nodes.get(id)
    if (
      node?.config.exec?.persistent !== undefined &&
      serverConfig(node, forwardArgs) === server.config
    )
      kept.set(id, server)
    else {
      server.handOver()
      stale.push(server.child)
    }
  }
  return { kept, stale }
}

/**
 * The kept server whose exit ends a foreground session, and its code. A
 * server kept only as a dependency that exits 0 is a daemon that forked
 * and returned (schema.md), not the end of the session: a
 * `db: 'docker compose up -d'` under `app#dev` stopped the dev server
 * right after the summary (WD-3). It ends the wait only as the last.
 */
export function sessionEnd(keepAlive: KeepAlive): Promise<{ code: number; i: number }> {
  return new Promise((resolve) => {
    let left = keepAlive.children.length
    keepAlive.children.forEach((c, i) => {
      void c.exited.then((code) => {
        left--
        const n = keepAlive.nodes[i]!
        if (code !== 0 || n.requested || n.surfaced === true || left === 0) resolve({ code, i })
      })
    })
  })
}

export interface HoldArgs {
  forwardArgs: readonly string[] | undefined
  /** Where a held server's output, and the notice of its death, go. */
  outOf: (id: string) => HeldServer['out']
}

/** The kept servers handed to the caller (`RunOptions.hold`) instead of waited on. */
export function holdServers(keepAlive: KeepAlive, args: HoldArgs): HeldPersistent {
  const held = keepAlive.children
  // A held server that dies on its own is said, as the foreground's
  // keep-alive says it: `vx watch` sat on "watching" over a dead dev
  // server. The holder's own stop() is not such a death.
  let stopping = false
  // Taken by a later run (`RunOptions.keep`): kept or stopped there.
  const handed = new Set<Child>()
  const servers = new Map<string, HeldServer>()
  keepAlive.nodes.forEach((n, i) => {
    const child = held[i]!
    const out = args.outOf(n.id)
    servers.set(n.id, {
      child,
      config: serverConfig(n, args.forwardArgs),
      out,
      handOver: () => void handed.add(child),
    })
    // One that died during the graph was said then.
    if (hasEnded(child)) return
    // Said where its output goes: a later run that keeps it owns the
    // terminal from its start, and this run's renderer wrote over its rows.
    void child.exited.then((code) => {
      if (!stopping && !handed.has(child) && code !== 0)
        out.bus.emit({
          kind: 'run:status',
          line: `vx: ${n.id} exited with code ${code}`,
          warn: true,
        })
    })
  })
  return {
    ids: keepAlive.nodes.map((n) => n.id),
    servers,
    stop: (signal) => {
      stopping = true
      return terminateChildren(() => held.filter((c) => !handed.has(c)), signal)
    },
  }
}

/**
 * A server that died on its own before the stop failed, whatever its
 * outcome said when it became ready: the footer counted it a success over
 * the run's red exit (item 1071). Its code is its own, or the shell's
 * report of the signal that took it. In place: the renderer holds this
 * outcome (events carry live refs) and closes the server's output block
 * from it at runEnd, where a copy left it reading `running` under its exit
 * line (WD-10).
 */
export function failServer(
  outcomes: ReadonlyMap<string, TaskOutcome>,
  id: string,
  code: number | string,
): void {
  const o = outcomes.get(id)
  if (o === undefined) return
  o.status = 'failed'
  o.exitCode = typeof code === 'number' ? code : signalExitCode(code)
}

/**
 * The end of the graph for its servers: which stay up (`selectKeepAlive`),
 * the bounded shutdown of the rest, and each one that died on its own
 * failed. A run that failed elsewhere keeps nothing: `vx run dev --all`
 * with one server that never became ready sat on the others for good, so
 * a script hung, and the Ctrl-C that ended it read 130 over the failure
 * (C-60). A kept server's own crash ends the keep-alive wait as before,
 * and `--continue=always` asked to keep going, and does. The watch loop
 * (`hold`) still holds: a failing test in a cycle stopped the dev server
 * the next change would restart anyway. A kept server that has already
 * died fails too; the keep-alive wait names it.
 */
export async function disposeServers(args: {
  registry: ReadonlyMap<string, Child>
  nodes: ReadonlyMap<string, TaskNode>
  outcomes: ReadonlyMap<string, TaskOutcome>
  /** Keep the requested servers up: the CLI foreground, or a hold. */
  keep: boolean
  hold: boolean
  continueAlways: boolean
  /** The servers that had ended when a stop landed; undefined without a stop. */
  endedBeforeStop: ReadonlySet<Child> | undefined
}): Promise<{ keepAlive: KeepAlive; crashed: CrashedPersistent[] }> {
  const { registry, outcomes, endedBeforeStop } = args
  // One turn of the event loop first, so Bun reaps what has already died:
  // `exitCode` stays null until it does. A server dead at once, with
  // nothing between its spawn and here to yield, was judged still up: the
  // footer counted it a success, pinned it `running`, and a teardown read
  // the run ok over vx's exit 1.
  if (registry.size > 0) await new Promise((resolve) => setTimeout(resolve, 0))
  let keepAlive = selectKeepAlive(registry, args.nodes, args.keep)
  const failedElsewhere =
    ![...outcomes.values()].every((o) => isPassStatus(o.status)) ||
    [...registry.values()].some(
      (c) => hasEnded(c) && c.exitCode !== 0 && !keepAlive.children.includes(c),
    )
  if (failedElsewhere && !args.hold && !args.continueAlways) keepAlive = { nodes: [], children: [] }
  const crashed = (await shutdownPersistent(registry, keepAlive.children)).filter(
    (c) => endedBeforeStop?.has(registry.get(c.id)!) ?? true,
  )
  for (const c of crashed) failServer(outcomes, c.id, c.code)
  keepAlive.nodes.forEach((n, i) => {
    const child = keepAlive.children[i]!
    if (!hasEnded(child) || child.exitCode === 0) return
    if (endedBeforeStop !== undefined && !endedBeforeStop.has(child)) return
    failServer(outcomes, n.id, child.exitCode ?? child.signalCode ?? 'unknown')
  })
  return { keepAlive, crashed }
}
