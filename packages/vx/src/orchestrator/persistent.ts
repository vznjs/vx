// End-of-run disposition of persistent children (dev servers, watchers).
// `executeTask` spawns them and returns at "ready" without awaiting exit;
// ownership moves to the run's registry, and this is the one place that
// decides which of them outlive the graph and how the rest go down.

import type { TaskNode } from '../graph/index.js'
import { killGraceMs } from '../util/index.js'
import { holdGroups, killTree, untilGroupsGone } from '../exec/index.js'

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
 * after the summary. Only in the real CLI foreground: a custom logger or
 * `handleSignals: false` (watch mode, embedders) expects `run()` to return,
 * not to sit on a server.
 */
export function selectKeepAlive(
  registry: ReadonlyMap<string, Child>,
  nodes: ReadonlyMap<string, TaskNode>,
  foreground: boolean,
): KeepAlive {
  const out: KeepAlive = { nodes: [], children: [] }
  if (!foreground) return out
  for (const [id, child] of registry) {
    const n = nodes.get(id)
    if (n !== undefined && (n.requested || n.surfaced === true)) {
      out.nodes.push(n)
      out.children.push(child)
    }
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
