// A branch's cache scope (owner, 2026-10-17): the local store never knows
// one, so every branch shares one local pool under the task keys. Scopes
// decide only which remote entry a task asks for: a task the branch changed
// reads the scope's key, every other task the default key, and a scoped run
// writes every remote under the scope's key. An artifact is packed under its
// task key wherever it is stored, so a remote entry ingests under that key.

import { xxh3hex } from '../util/index.js'
import type { RemoteCacheLayer } from './layered-cache.js'

/** The key a scope stores `hash` under: task-key shaped, 16 hex, so every wire stores it unchanged. */
export function scopedKey(scope: string, hash: string): string {
  return xxh3hex(`vx-cache-scope\0${scope}\0${hash}`)
}

/** Which remote key each task asks for, in a run with a scope. */
export class BranchScope {
  /** The tasks that read the scope; null: every task does. */
  private tasks: ReadonlySet<string> | null = null
  /** Task keys of the tasks that read the default key. */
  private readonly plain = new Set<string>()

  constructor(readonly scope: string) {}

  /** From here only `ids` read the scope; set before any task is keyed. */
  routeTasks(ids: ReadonlySet<string>): void {
    this.tasks = ids
  }

  noteKey(taskId: string, hash: string): void {
    if (this.tasks !== null && !this.tasks.has(taskId)) this.plain.add(hash)
  }

  private readKey(hash: string): string {
    return this.plain.has(hash) ? hash : scopedKey(this.scope, hash)
  }

  /** `inner` as this run asks it: each task key under its route's key; every write under the scope's. */
  remote(inner: RemoteCacheLayer): RemoteCacheLayer {
    const read = (h: string) => this.readKey(h)
    const own = (h: string) => scopedKey(this.scope, h)
    const hasMany = inner.hasMany
    return {
      ...(inner.endpoint !== undefined ? { endpoint: inner.endpoint } : {}),
      ...(inner.open !== undefined ? { open: (ctx) => inner.open!(ctx) } : {}),
      has: (h) => inner.has(read(h)),
      ...(hasMany !== undefined
        ? {
            hasMany: async (hashes) => {
              const keys = hashes.map(read)
              const found = await hasMany.call(inner, keys)
              if (!(found instanceof Set)) return found
              return new Set(hashes.filter((_, i) => found.has(keys[i]!)))
            },
          }
        : {}),
      get: (h) => inner.get(read(h)),
      put: (h, body, meta) => inner.put(own(h), body, meta),
    }
  }
}
