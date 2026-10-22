// A server the run's local store cannot settle: some dependant missed here
// but may be a hit the remote holds. The scheduler holds such a server
// until the remote answers; when every dependant hit, the server never
// starts (M 2026-10-22), as it never starts behind local hits.

import type { TaskNode } from '../graph/index.js'
import type { CacheEntry, CacheLayer } from '../cache/index.js'
import type { ShortCircuit } from './local-shortcircuit.js'
import { getContext } from './remote-prefetch.js'

/** The persistent tasks nobody asked for whose every dependant is a local hit or a key the remote may hold. */
export function serversToHold(
  nodes: ReadonlyMap<string, TaskNode>,
  restoreTier: ReadonlySet<string>,
  remoteAsk: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (remoteAsk.size === 0) return out
  const dependents = new Map<string, string[]>()
  for (const n of nodes.values())
    for (const d of n.deps) {
      const list = dependents.get(d)
      if (list === undefined) dependents.set(d, [n.id])
      else list.push(n.id)
    }
  for (const n of nodes.values()) {
    if (n.config.exec?.persistent === undefined || n.requested || n.surfaced === true) continue
    const ds = dependents.get(n.id)
    if (
      ds !== undefined &&
      ds.every((d) => restoreTier.has(d) || remoteAsk.has(d)) &&
      ds.some((d) => remoteAsk.has(d))
    )
      out.set(n.id, ds)
  }
  return out
}

/**
 * For each held server, whether the remote holds every dependant: one
 * `get` per dependant through the layered cache, which shares the
 * prefetch's request. All hits join the restore tier at once, so the
 * scheduler finds the server idle; the first miss answers at once, with
 * nothing promoted, so the server starts without waiting on the rest.
 */
export function askRemote(
  held: ReadonlyMap<string, readonly string[]>,
  nodes: ReadonlyMap<string, TaskNode>,
  shortCircuit: Pick<ShortCircuit, 'preProbed' | 'restoreTier' | 'remoteAsk'>,
  cache: CacheLayer,
): Map<string, Promise<readonly string[]>> {
  const asked = new Map<string, Promise<CacheEntry | null>>()
  const ask = (id: string): Promise<CacheEntry | null> => {
    let p = asked.get(id)
    if (p === undefined) {
      const node = nodes.get(id)!
      p = cache
        .get(shortCircuit.remoteAsk.get(id)!, getContext(node, node.config.exec?.command ?? ''))
        .catch(() => null)
      asked.set(id, p)
    }
    return p
  }
  const out = new Map<string, Promise<readonly string[]>>()
  for (const [server, ds] of held) {
    const remote = ds.filter((d) => shortCircuit.remoteAsk.has(d))
    out.set(
      server,
      new Promise((resolve) => {
        const hits = new Map<string, CacheEntry>()
        for (const d of remote)
          void ask(d).then((hit) => {
            if (hit === null) return resolve([])
            hits.set(d, hit)
            if (hits.size < remote.length) return
            for (const [id, entry] of hits) {
              shortCircuit.preProbed.set(id, { hash: shortCircuit.remoteAsk.get(id)!, hit: entry })
              shortCircuit.restoreTier.add(id)
            }
            resolve(remote)
          })
      }),
    )
  }
  return out
}
