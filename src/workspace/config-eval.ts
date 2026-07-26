// Re-evaluating a project config, import closure included, inside a
// long-lived process.
//
// The loader's query-string bust only changes the ENTRY's specifier.
// Bun caches an evaluated module by its RESOLVED specifier, so an
// `import './preset.js'` inside a config resolves to the same key no
// matter what query the entry carries — a busted entry re-evaluates
// against a STALE preset. Shared presets are the documented composition
// mechanism (`vx migrate` generates one), so through a whole `vx watch`
// session a preset edit was invisible; and because the resolved config
// feeds the cache key, vx answered `up-to-date` for a command that had
// changed on disk.
//
// A Worker gets its own module registry, so everything it imports is
// read from disk NOW. It is the only mechanism for this that the
// runtime exposes as public API: `globalThis.Loader.registry` — the
// obvious place to evict from — exists on Bun 1.3.11 and is GONE on
// 1.3.14, where an eviction-based fix degrades to no fix at all while
// still reporting success.
//
// The worker source is an inline data: URL, not a sibling file, because
// `bun build --compile` does NOT embed a Worker entry point — it
// resolves the URL from disk at runtime, so a sibling file would make
// the shipped standalone binary fail with ModuleNotFound.
//
// The config crosses back as JSON. That is already this project's
// contract for a config object: `hashTaskConfig` derives the cache key
// from `JSON.stringify(config)` and `vx lock` stores the same
// round-trip, so a JSON round-trip cannot change how a config hashes,
// locks or runs. `JSON.stringify(JSON.parse(s)) === s`, so a config
// re-read through a worker derives the SAME cache key as the
// in-process first load — which is why this needs no CACHE_VERSION bump.

import path from 'node:path'

const WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, path } = e.data
  try {
    const ns = await import(path)
    const mod = ns?.default
    postMessage({
      id,
      ok: true,
      json: mod !== null && typeof mod === 'object' ? JSON.stringify(mod) : null,
    })
  } catch (err) {
    postMessage({
      id,
      ok: false,
      name: err?.name ?? 'Error',
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
    })
  }
}
`

const WORKER_URL = `data:text/javascript,${encodeURIComponent(WORKER_SRC)}`

interface WorkerReply {
  id: number
  ok: boolean
  json: string | null
  name: string
  message: string
  stack: string | null
}

interface Pending {
  resolve: (json: string | null) => void
  reject: (err: Error) => void
}

const pending = new Map<number, Pending>()
let worker: Worker | null = null
let inFlight = 0
let nextId = 0
let workersCreated = 0

/**
 * Workers created so far. Exported solely so a test can pin that ONE
 * worker serves a whole concurrent round — the property that keeps a
 * 1000-project watch cycle at one worker instead of a thousand.
 */
export function configEvalWorkerCount(): number {
  return workersCreated
}

function rejectAll(err: Error): void {
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

/**
 * The worker serving the current round. Every load that is in flight at
 * the same moment shares it, and it is retired once the last of them
 * settles — so a `Promise.all` round costs ONE worker, and the next
 * round (the next watch cycle) still starts from an empty registry.
 *
 * Sharing within a round is also the more faithful semantics: two
 * configs importing the same preset evaluate it once, exactly as they
 * would in a fresh `vx run` process.
 */
function acquireWorker(): Worker {
  if (worker !== null) return worker
  const w = new Worker(WORKER_URL)
  workersCreated++
  w.onmessage = (event: MessageEvent): void => {
    const msg = event.data as WorkerReply
    const p = pending.get(msg.id)
    if (p === undefined) return
    pending.delete(msg.id)
    if (msg.ok) {
      p.resolve(msg.json)
      return
    }
    // Rebuild the error the config actually threw. Name, message and
    // stack all survive the hop, so a broken config reports the same
    // text it would from an in-process import.
    const err = new Error(msg.message)
    err.name = msg.name
    if (msg.stack !== null) err.stack = msg.stack
    p.reject(err)
  }
  w.onerror = (event: ErrorEvent): void => {
    rejectAll(new Error(`config worker failed: ${String(event.message)}`))
  }
  worker = w
  return w
}

/**
 * Evaluate `configPath` against a fresh module registry and return its
 * default export, JSON round-tripped. `null` means the module had no
 * object default export — the caller owns that error message so it
 * reads identically whichever path produced it.
 */
export async function evaluateConfigFresh(configPath: string): Promise<unknown> {
  const abs = path.resolve(configPath)
  const id = nextId++
  inFlight++
  try {
    const w = acquireWorker()
    const json = await new Promise<string | null>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage({ id, path: abs })
    })
    return json === null ? null : (JSON.parse(json) as unknown)
  } finally {
    pending.delete(id)
    inFlight--
    if (inFlight === 0 && worker !== null) {
      worker.terminate()
      worker = null
    }
  }
}
