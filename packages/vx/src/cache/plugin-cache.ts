// A plugin's own entries in the cache the workspace declares (`ctx.cache`,
// 2026-10-14): the local store first, then each remote in declared
// order, under the run's policy and scope. The plugin speaks names; core
// derives the key, so no plugin reaches another's entries or a task's. An
// entry is written once and never replaced (the cache is immutable). Every
// failure is an absent answer, never a warning (M: no extra runtime
// warnings): what a plugin keeps here is a hint.

import type { Database } from 'bun:sqlite'
import { thrownMessage, xxh3hex } from '../util/index.js'
import type { CachePolicy } from './policy.js'
import { sayRemoteFault, type ResolvedRemote } from './remote-lane.js'
import { scopedKey } from './scoped-cache.js'
import { runReadKeys } from './run-store.js'

/** The largest entry kept or read, in bytes: a remote's larger body is a miss, read no further. */
export const PLUGIN_ENTRY_MAX_BYTES = 1024 * 1024

/** What a plugin's `ctx.cache` offers. Keys are the plugin's own names. */
export interface PluginCache {
  /**
   * The bytes stored under `key`, from the first layer holding them; null
   * when none does. On a scoped run a remote is asked for the branch's
   * entry, or with `scoped` false the base branch's: one request either way.
   */
  get(key: string, scoped?: boolean): Promise<Uint8Array | null>
  /** Store `bytes` under `key` in every layer the policy writes, where it is not already; empty bytes store nothing. */
  put(key: string, bytes: Uint8Array): Promise<void>
  /** Whether some layer holds `key`; null when no layer could answer. */
  has(key: string, scoped?: boolean): Promise<boolean | null>
  /**
   * The subset of `keys` some layer holds, in one probe per layer; null
   * when a readable remote has no batch probe: ask `get` one at a time.
   */
  hasMany(keys: readonly string[], scoped?: boolean): Promise<Set<string> | null>
  /**
   * What core kept of a run under `name` (a `log` or `outputs` name its
   * `RunReport` hands `teardown`), from the first readable remote holding
   * it; null when none does. Uncapped: core wrote it.
   */
  getRun(name: string): Promise<Uint8Array | null>
}

export interface PluginCacheHost {
  /** The run's index; its store holds `plugin_blobs`. */
  readonly db: Database
  readonly policy: CachePolicy
  readonly remotes: readonly ResolvedRemote[]
  readonly scope: string | undefined
}

/** The key `name` stores under for `plugin`: task-key shaped, so every wire stores it unchanged. */
function entryKey(plugin: string, name: string): string {
  return xxh3hex(`vx-plugin\0${plugin}\0${name}`)
}

/**
 * A remote body's bytes; null past the cap (read no further than it) and for
 * an empty or odd body, which kept would hide every later good one: an entry
 * is written once (Security, #3580).
 */
async function capped(body: unknown, max = PLUGIN_ENTRY_MAX_BYTES): Promise<Uint8Array | null> {
  if (body instanceof Blob) {
    if (body.size === 0 || body.size > max) return null
    return new Uint8Array(await body.arrayBuffer())
  }
  if (!(body instanceof Response) || body.body === null) return null
  const reader = body.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      // quiet: the body is refused for its size, said by the miss; its cancel adds nothing
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  if (size === 0) return null
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/**
 * `plugin`'s view of the cache. The local store never knows a scope
 * (2026-10-17): it keeps every entry under its name's key. A scoped
 * run writes a remote only under the scope's key, and reads one key: the
 * scope's, or with `scoped` false the default (2026-10-18: no request
 * twice).
 */
export function pluginCache(plugin: string, host: PluginCacheHost): PluginCache {
  const { db, policy, scope } = host
  // A plugin's entries are not task artifacts: a policy that reads no
  // remote artifact (a cold run, `--force`) still reads them, so the run is
  // planned on the default branch's timings. A cold CI run asked workers
  // for 128 tasks with 0 measured, at 25% of their cores (2026-10-23).
  const readers = host.remotes.filter((r) => r.read || r.write)
  const writers = host.remotes.filter((r) => r.write)
  // Each remote's fault said once per kind: unsaid, a remote down left DTE
  // planning on no timings and no line said why.
  const said = new Map<ResolvedRemote, Set<string>>()
  const fault = (r: ResolvedRemote, op: string, what: string, err: unknown): void => {
    const message = thrownMessage(err)
    const seen = said.get(r) ?? new Set<string>()
    said.set(r, seen)
    if (seen.has(`${op}\0${message}`)) return
    seen.add(`${op}\0${message}`)
    sayRemoteFault(r, new Error(`${op} of ${plugin}'s ${what} failed: ${message}`, { cause: err }))
  }
  const readKey = (name: string, scoped: boolean): string => {
    const key = entryKey(plugin, name)
    return scope === undefined || !scoped ? key : scopedKey(scope, key)
  }
  const writeKey = (name: string): string => {
    const key = entryKey(plugin, name)
    return scope === undefined ? key : scopedKey(scope, key)
  }

  const localGet = (key: string): Uint8Array | null => {
    if (!policy.localRead) return null
    try {
      const row = db.query('SELECT bytes FROM plugin_blobs WHERE key = ?').get(key) as {
        bytes: Uint8Array
      } | null
      return row === null ? null : new Uint8Array(row.bytes)
      // quiet: the local index, not a remote: an unreadable one holds nothing
    } catch {
      return null
    }
  }
  const localHas = (keys: readonly string[]): Set<string> => {
    const found = new Set<string>()
    if (!policy.localRead || keys.length === 0) return found
    try {
      const rows = db
        .query(`SELECT key FROM plugin_blobs WHERE key IN (${keys.map(() => '?').join(', ')})`)
        .all(...keys) as Array<{ key: string }>
      for (const r of rows) found.add(r.key)
      // quiet: the local index, not a remote
    } catch {
      // an unreadable index holds nothing
    }
    return found
  }
  const localPut = (key: string, bytes: Uint8Array): void => {
    try {
      db.query('INSERT OR IGNORE INTO plugin_blobs(key, bytes, at) VALUES (?, ?, ?)').run(
        key,
        bytes,
        Date.now(),
      )
      // quiet: the local index, not a remote
    } catch {
      // a read-only or busy index keeps nothing
    }
  }

  return {
    async get(name, scoped = true) {
      const local = entryKey(plugin, name)
      const hit = localGet(local)
      if (hit !== null) return hit
      const key = readKey(name, scoped)
      for (const r of readers) {
        try {
          const got = await r.remote.get(key)
          if (got === null) continue
          const bytes = await capped(got.body)
          if (bytes === null) continue
          if (policy.localWrite) localPut(local, bytes)
          return bytes
        } catch (err) {
          // a failing remote is a miss there
          fault(r, 'get', name, err)
        }
      }
      return null
    },

    async put(name, bytes) {
      if (bytes.byteLength === 0 || bytes.byteLength > PLUGIN_ENTRY_MAX_BYTES) return
      const key = writeKey(name)
      if (policy.localWrite) localPut(entryKey(plugin, name), bytes)
      for (const r of writers) {
        try {
          await r.remote.put(key, new Blob([bytes]), { durationMs: 0 })
        } catch (err) {
          // the other layers still keep it
          fault(r, 'put', name, err)
        }
      }
    },

    async has(name, scoped = true) {
      if (localHas([entryKey(plugin, name)]).size > 0) return true
      const key = readKey(name, scoped)
      let answered = policy.localRead
      for (const r of readers) {
        try {
          if (await r.remote.has(key)) return true
          answered = true
        } catch (err) {
          // no answer from this remote
          fault(r, 'has', name, err)
        }
      }
      return answered ? false : null
    },

    async hasMany(names, scoped = true) {
      const byKey = new Map<string, string>()
      for (const name of names) byKey.set(readKey(name, scoped), name)
      const keys = [...byKey.keys()]
      const found = new Set<string>()
      // The local store keys entries unscoped (`entryKey`), not by `readKey`.
      const byLocal = new Map(names.map((n) => [entryKey(plugin, n), n]))
      for (const key of localHas([...byLocal.keys()])) found.add(byLocal.get(key)!)
      for (const r of readers) {
        const ask = keys.filter((k) => !found.has(byKey.get(k)!))
        if (ask.length === 0) break
        if (r.remote.hasMany === undefined) return null
        try {
          const got: unknown = await r.remote.hasMany(ask)
          if (!(got instanceof Map)) return null
          for (const key of got.keys())
            if (byKey.has(key as string)) found.add(byKey.get(key as string)!)
        } catch (err) {
          fault(r, 'hasMany', `${ask.length} entries`, err)
          return null
        }
      }
      return found
    },

    async getRun(name) {
      for (const r of readers) {
        for (const key of runReadKeys(name, scope)) {
          try {
            const got = await r.remote.get(key)
            if (got === null) continue
            const bytes = await capped(got.body, Infinity)
            if (bytes !== null) return bytes
          } catch (err) {
            // a failing remote is a miss there
            fault(r, 'get', name, err)
          }
        }
      }
      return null
    },
  }
}

/** A cache with no layer: every answer absent. What a context built outside a run holds. */
export const absentPluginCache: PluginCache = {
  get: async () => null,
  put: async () => {},
  has: async () => null,
  hasMany: async () => null,
  getRun: async () => null,
}
