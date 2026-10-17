// A branch's cache scope (owner, 2026-10-17): the local store never knows
// one, so every branch shares one local pool under the task keys. Scopes
// decide only which remote entry a task asks for: a task the branch changed
// reads the scope's key, every other task the default key, and a scoped run
// writes every remote under the scope's key. An artifact is packed under its
// task key wherever it is stored, so a remote entry ingests under that key.

import { xxh3hex } from '../util/index.js'
import type { RemoteCacheLayer, RemoteKey } from './layered-cache.js'

/** The key a scope stores `hash` under: task-key shaped, 16 hex, so every wire stores it unchanged. */
export function scopedKey(scope: string, hash: string): string {
  return xxh3hex(`vx-cache-scope\0${scope}\0${hash}`)
}

/**
 * Which remote key each task asks for, in a run with a scope. The routes
 * come from the branch's diff, which only a remote call awaits: a run the
 * local cache answers never waits on git.
 */
export class BranchScope {
  /** Finds the tasks that read the scope, at the first remote call; null: every task does. */
  private route: (() => Promise<ReadonlySet<string>>) | null = null
  private routes: Promise<ReadonlySet<string>> | null = null
  /** Task key → its task. */
  private readonly taskOf = new Map<string, string>()

  constructor(readonly scope: string) {}

  /** Only the tasks `ids` finds read the scope; set before any remote call. */
  routeTasks(ids: () => Promise<ReadonlySet<string>>): void {
    this.route = ids
  }

  noteKey(taskId: string, hash: string): void {
    this.taskOf.set(hash, taskId)
  }

  /** The remote key `hash` is read under, and the scope it is read in (none: the default key). */
  private async readKey(hash: string): Promise<{ key: string; at: RemoteKey }> {
    const id = this.taskOf.get(hash)
    if (this.route !== null) this.routes ??= this.route()
    const tasks = this.routes === null ? null : await this.routes
    return tasks !== null && id !== undefined && !tasks.has(id)
      ? { key: hash, at: {} }
      : { key: scopedKey(this.scope, hash), at: { scope: this.scope } }
  }

  /**
   * `inner` as this run asks it: each task key under its route's key; every
   * write under the scope's. Each call also names its scope, for a backend
   * that keeps one store per scope; no wire vx ships sends it.
   */
  remote(inner: RemoteCacheLayer): RemoteCacheLayer {
    const read = (h: string) => this.readKey(h)
    const at: RemoteKey = { scope: this.scope }
    const hasMany = inner.hasMany
    return {
      ...(inner.endpoint !== undefined ? { endpoint: inner.endpoint } : {}),
      ...(inner.open !== undefined ? { open: (ctx) => inner.open!(ctx) } : {}),
      has: async (h) => {
        const r = await read(h)
        return inner.has(r.key, r.at)
      },
      ...(hasMany !== undefined
        ? {
            hasMany: async (hashes) => {
              const reads = await Promise.all(hashes.map(read))
              const keys = reads.map((r) => r.key)
              const found = await hasMany.call(
                inner,
                keys,
                reads.map((r) => r.at),
              )
              if (!(found instanceof Set)) return found
              return new Set(hashes.filter((_, i) => found.has(keys[i]!)))
            },
          }
        : {}),
      get: async (h) => {
        const r = await read(h)
        return inner.get(r.key, r.at)
      },
      put: (h, body, meta) => inner.put(scopedKey(this.scope, h), body, { ...meta, ...at }),
    }
  }
}
