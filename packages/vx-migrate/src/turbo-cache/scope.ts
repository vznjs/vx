import { type ArtifactInfo, type RemoteCacheLayer, UserError } from '@vzn/vx'

/**
 * How a remote keeps branches apart (2026-10-20). `'header'`: plain keys,
 * and every read names the refs it may be answered from, in order, in
 * `x-artifact-read-scopes`; a server that files writes by the caller's CI
 * token reads them, any other ignores it. `'key'`: each entry's key also
 * folds a ref, for a server that keeps one bucket; a read asks each ref's
 * key and the first hit wins.
 */
export type RemoteScope = 'header' | 'key'

/** `factory`: the option's owner as a workspace calls it, `turboCache`. */
export function remoteScope(factory: string, scope: unknown): RemoteScope {
  if (scope === undefined || scope === 'header' || scope === 'key') return scope ?? 'header'
  throw new UserError(`${factory}(): scope must be 'header' or 'key', got ${JSON.stringify(scope)}`)
}

/** A server caps the read header at this many refs (the server rules), so vx never sends more. */
const MAX_READ_SCOPES = 8

/** The read header: the refs in order. Writes carry none: the server files them by the token. */
export function readScopes(refs: readonly string[]): Record<string, string> {
  return refs.length === 0
    ? {}
    : { 'x-artifact-read-scopes': refs.slice(0, MAX_READ_SCOPES).join(', ') }
}

/** The key `ref` stores `hash` under: 16 hex, task-key shaped, so every wire takes it. */
export function refKey(ref: string, hash: string): string {
  return Bun.hash.xxHash3(`vx-cache-ref\0${ref}\0${hash}`).toString(16).padStart(16, '0')
}

const QUEUE = /^refs\/heads\/gh-readonly-queue\//

/**
 * `inner` keyed by ref: a write lands under the run's own ref's key (a
 * merge queue's, its base branch's, which its results become), a read asks
 * each ref's key in order. A merge queue's own ref holds nothing, so it is
 * never asked.
 */
export function keyedByRef(inner: RemoteCacheLayer, allRefs: readonly string[]): RemoteCacheLayer {
  const refs = QUEUE.test(allRefs[0] ?? '') ? allRefs.slice(1) : allRefs
  const write = refs[0]
  if (write === undefined) return inner
  /** Task key → the stored key a batch probe found it under. */
  const found = new Map<string, string>()
  const hasMany = inner.hasMany
  const firstHeld = async (hash: string): Promise<ArtifactInfo | null> => {
    const known = found.get(hash)
    if (known !== undefined) return inner.has(known)
    for (const ref of refs) {
      const info = await inner.has(refKey(ref, hash))
      if (info !== null) return info
    }
    return null
  }
  return {
    ...(inner.endpoint !== undefined ? { endpoint: inner.endpoint } : {}),
    ...(inner.open !== undefined ? { open: (ctx) => inner.open!(ctx) } : {}),
    ...(inner.lend !== undefined ? { lend: () => inner.lend!() } : {}),
    has: firstHeld,
    ...(hasMany !== undefined
      ? {
          hasMany: async (hashes) => {
            const keys = hashes.map((h) => refs.map((r) => refKey(r, h)))
            const held = await hasMany.call(inner, keys.flat())
            if (held === null) return null
            const out = new Map<string, ArtifactInfo>()
            hashes.forEach((h, i) => {
              const key = keys[i]!.find((k) => held.has(k))
              if (key === undefined) return
              found.set(h, key)
              out.set(h, held.get(key)!)
            })
            return out
          },
        }
      : {}),
    get: async (hash) => {
      const known = found.get(hash)
      if (known !== undefined) return inner.get(known)
      for (const ref of refs) {
        const hit = await inner.get(refKey(ref, hash))
        if (hit !== null) return hit
      }
      return null
    },
    put: (hash, body, meta) => inner.put(refKey(write, hash), body, meta),
  }
}
