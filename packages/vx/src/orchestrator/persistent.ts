// End-of-run disposition of persistent children (dev servers, watchers).
// `executeTask` spawns them and returns at "ready" without awaiting exit;
// ownership moves to the run's registry, and this is the one place that
// decides which of them outlive the graph and how the rest go down.

import type { TaskNode } from '../graph/index.js'
import { killGraceMs } from '../util/index.js'
import { killTree } from '../exec/index.js'

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
 * to clean up; past the grace the stragglers are SIGKILLed so the run's
 * normal completion cannot hang on one that traps the signal. Bun's
 * `kill` is idempotent on an exited child; the timer is cleared and
 * unref'd so a fast shutdown never delays CLI exit.
 */
export async function shutdownPersistent(
  registry: ReadonlyMap<string, Child>,
  keepAlive: readonly Child[],
  graceMs: number = killGraceMs(PERSISTENT_SHUTDOWN_GRACE_MS),
): Promise<void> {
  const kept = new Set(keepAlive)
  const dying = [...registry.values()].filter((c) => !kept.has(c))
  if (dying.length === 0) return
  for (const child of dying) killTree(child, 'SIGTERM')
  const allExited = Promise.allSettled(dying.map((c) => c.exited))
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const winner = await Promise.race([
    allExited.then(() => 'exited' as const),
    new Promise<'grace'>((resolve) => {
      graceTimer = setTimeout(() => resolve('grace'), graceMs)
      graceTimer.unref?.()
    }),
  ])
  if (graceTimer !== undefined) clearTimeout(graceTimer)
  if (winner === 'grace') {
    for (const child of dying) killTree(child, 'SIGKILL')
    await allExited
  }
}
