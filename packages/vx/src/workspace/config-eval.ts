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
// What JSON would drop or rewrite never makes the trip: the worker runs
// `nonJsonPaths` (json-data.ts) on the live object first, embedded by its
// source so the rule has one copy, and the parent refuses what it names
// with the message the first load gives (item 701).

import path from 'node:path'
import { MAX_TIMEOUT_MS, UserError } from '../util/index.js'
import { nonJsonMessage, nonJsonPaths, type NonJsonValue } from './json-data.js'

/** Why a config's `process.exit` throws, on both load paths (D-65). */
export const CONFIG_EXIT = 'a config exports its object; it cannot end the run'

/**
 * The built-ins a config must not change: vx reads every other config and
 * makes every cache key through them (D-74, D-75). The loader watches them
 * in this process; the worker, asked to blame, in its own.
 */
export const WATCHED_BUILTIN_NAMES = [
  'Object.prototype',
  'Array.prototype',
  'Bun',
  'Bun.hash',
  'JSON',
  'Math',
  'String.prototype',
  'Map.prototype',
  'Set.prototype',
  'Promise.prototype',
  // A global one config set reached every config loaded after it in the
  // process: `--all` read it, `--filter` of the reader alone did not (D-122).
  'globalThis',
  // What the check itself and vx's matching read through: a replaced
  // `Reflect.ownKeys` blinded the check, and `RegExp.prototype.test` or
  // `Date.now` ran vx on a config's choice (D-124).
  'Reflect',
  'Object',
  'Array',
  'RegExp.prototype',
  'Function.prototype',
  'Date',
  'Date.prototype',
  'Number.prototype',
] as const

const WORKER_SRC = `
const nonJsonPaths = ${nonJsonPaths.toString()}
// The parent's stdout is a verb's JSON or vx mcp's JSON-RPC stream, and a
// config printing on a repeat load wrote into it: the server's own redirect
// covers the parent thread only (D-64). This worker only evaluates configs,
// so every route to fd 1 is stderr's, Bun's own included (item 1069).
// Synchronous, before any message: an awaited import of the Console left
// the first evaluation racing its own redirect (D-73).
{
  const P = globalThis.process
  const B = globalThis.Bun
  const Console = globalThis.console.Console
  globalThis.console = Object.assign(new Console(P.stderr, P.stderr), {
    write: (...data) => {
      const text = data.join('')
      P.stderr.write(text)
      return text.length
    },
  })
  P.stdout.write = (...args) => P.stderr.write(...args)
  const ownBunWrite = B.write
  B.write = (dest, ...rest) => ownBunWrite(dest === B.stdout ? B.stderr : dest, ...rest)
  B.stdout.writer = (...args) => B.stderr.writer(...args)
  // An exit here ended the worker unheard, and the load waited out its
  // whole deadline to say the worker did not answer (D-65).
  P.exit = (code) => {
    throw new Error('process.exit(' + (code ?? '') + ') in a config: ' + ${JSON.stringify(CONFIG_EXIT)})
  }
}
// Bun's resolver reads \\ as a separator, so a config under a\\b is served
// from the path as written (project-loader.ts's LITERAL_QUERY), read now.
let literal = false
const serveLiteral = () => {
  if (literal) return
  literal = true
  globalThis.Bun.plugin({
    name: 'vx-config-literal',
    setup(build) {
      build.onResolve({ filter: /\\?vx-literal$/ }, (args) => ({ path: args.path, namespace: 'file' }))
      build.onLoad({ filter: /\\?vx-literal$/ }, async (args) => {
        const file = args.path.slice(0, -'?vx-literal'.length)
        return { contents: await globalThis.Bun.file(file).text(), loader: /\\.[cm]?ts$/.test(file) ? 'ts' : 'js' }
      })
    },
  })
}
self.onmessage = async (e) => {
  const { id, path, env } = e.data
  // A Worker starts with the process's STARTUP environment, not the
  // parent's process.env as written since (probed): a config reading an
  // env var set in-process evaluated with it on the first load and without
  // it on every later one, and an embedder's second run() derived a
  // different key (D-61). Each request carries the parent's env now.
  // Through globalThis: the playground bundles this source as a string, and
  // its free-global scan reads a bare process after a paren as code.
  const live = globalThis.process.env
  for (const k of Object.keys(live)) if (!(k in env)) delete live[k]
  Object.assign(live, env)
  // A blame request reports the built-ins and env vars this one evaluation
  // changed, for a round whose loads overlapped and saw a change (D-119).
  const watched = e.data.blame
    ? ${JSON.stringify(WATCHED_BUILTIN_NAMES)}.map((n) => [n, n.split('.').reduce((o, k) => o[k], globalThis)])
    : null
  // Taken before the import: a config can replace them (D-124).
  const RO = Reflect.ownKeys
  const GD = Object.getOwnPropertyDescriptor
  const own = (o) => new Map(RO(o).map((k) => [k, GD(o, k)]))
  const before = watched?.map(([, o]) => own(o))
  const envBefore = watched ? { ...live } : null
  const cwdBefore = watched ? globalThis.process.cwd() : null
  // The umask is the process's, not the worker's: a config's umask(0o777)
  // here left every file vx wrote after it 000 (D-125). Read only when
  // blaming, the one evaluation in flight: Bun reads it by setting 0 and
  // back, so this read beside the main thread's left the process at 0
  // and blamed an innocent config. An ordinary load's change is the
  // loader's to see, on the main thread, once the round is done.
  const umaskIn = watched ? globalThis.process.umask() : null
  const same = (a, b) =>
    a !== undefined && b !== undefined && Object.is(a.value, b.value) && a.get === b.get && a.set === b.set &&
    a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable
  const changed = () => {
    if (watched === null) return undefined
    const out = []
    watched.forEach(([n, o], i) => {
      const now = own(o)
      for (const k of new Set([...before[i].keys(), ...now.keys()]))
        if (!same(before[i].get(k), now.get(k))) out.push(n + '.' + String(k))
    })
    for (const k of new Set([...Object.keys(envBefore), ...Object.keys(live)]))
      if (envBefore[k] !== live[k]) out.push('process.env.' + k)
    if (globalThis.process.cwd() !== cwdBefore) out.push('process.cwd (a chdir)')
    if (globalThis.process.umask() !== umaskIn) out.push('process.umask')
    return out
  }
  const umaskBack = () => {
    if (umaskIn !== null && globalThis.process.umask() !== umaskIn) globalThis.process.umask(umaskIn)
  }
  try {
    const literalPath = path.includes('\\\\')
    if (literalPath) serveLiteral()
    const ns = await import(literalPath ? path + '?vx-literal' : path)
    // Awaited as the in-process load's async return flattens it: a Promise
    // default loaded on a run and was refused as "an instance of Promise"
    // on every later evaluation in the process (D-5).
    const mod = await ns?.default
    const isObject = mod !== null && typeof mod === 'object'
    const nonJson = isObject ? nonJsonPaths(mod) : []
    // Seen, then put back, BEFORE the reply: the caller terminates a
    // blaming worker as soon as it answers, and a restore after the reply
    // lost that race and left the process at the config's mask.
    const report = changed()
    umaskBack()
    postMessage({
      id,
      ok: true,
      nonJson,
      json: isObject && nonJson.length === 0 ? JSON.stringify(mod) : null,
      fn: typeof mod === 'function',
      changed: report,
    })
  } catch (thrown) {
    // Two syntax errors arrive as one AggregateError, whose own message
    // names no line; the in-process load reports the first (X-6), so the
    // hop does too (X-26).
    const err =
      thrown?.name === 'AggregateError' && Array.isArray(thrown.errors) && thrown.errors.length > 0
        ? thrown.errors[0]
        : thrown
    const report = changed()
    umaskBack()
    // A thrown string or plain object has no message, and String() of a
    // null-prototype object throws here, inside the catch.
    const isError = err !== null && typeof err === 'object' && typeof err.message === 'string'
    postMessage({
      id,
      ok: false,
      thrown: isError ? null : globalThis.Bun.inspect(err, { compact: true }),
      name: isError ? (err.name ?? 'Error') : 'Error',
      message: isError ? err.message : '',
      stack: isError ? (err.stack ?? null) : null,
      changed: report,
      position:
        err?.position && typeof err.position === 'object'
          ? { file: err.position.file, line: err.position.line, column: err.position.column }
          : null,
    })
  }
}
`

const FUNCTION_EXPORT = (): void => {}

const WORKER_URL = `data:text/javascript,${encodeURIComponent(WORKER_SRC)}`

interface WorkerReply {
  id: number
  ok: boolean
  json: string | null
  /** The default export is a function, which JSON cannot carry back. */
  fn?: boolean
  nonJson: NonJsonValue[]
  name: string
  message: string
  /** What a config threw that is not an Error, as `thrownValueMessage` shows it; null for an Error. */
  thrown?: string | null
  stack: string | null
  /** A transpile error's location — `BuildMessage.position`, trimmed to what the loader reads. */
  position: { file?: string; line?: number; column?: number } | null
}

interface Pending {
  resolve: (reply: WorkerReply) => void
  reject: (err: Error) => void
  configPath: string
}

/**
 * A config threw something that is not an Error: `throw 'no'` printed
 * `vx: no`, naming no file, and a null-prototype object crashed vx's own
 * error printer with a stack.
 */
export function thrownValueMessage(kind: string, configPath: string, shown: string): string {
  return `${kind} config ${configPath} threw ${shown}, which is not an Error`
}

/**
 * How long a single config evaluation may take, in the worker or in process
 * (D-66); in process a synchronous loop holds the thread the deadline needs. Real evaluations are ~10 ms; this exists only so a hung config or a
 * killed worker cannot stall a run or a long-lived process indefinitely. Read
 * per call so a test can drive the deadline instead of waiting it out.
 */
export function evalBudgetMs(): number {
  const raw = process.env['VX_CONFIG_WORKER_TIMEOUT_MS']
  // Same kind of value as the teardown deadline, so the same treatment: a
  // BOUND on a worker that may be wedged, with no "no limit" reading. Falls
  // back rather than clamping, because honouring ~24.8 days would hang
  // `vx watch` forever on a worker the OS killed — and unbounded makes it 1 ms,
  // so EVERY config load times out instead. Both ends break the same feature.
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const n = Number(raw)
    if (n <= MAX_TIMEOUT_MS) return n
  }
  return 30_000
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
      p.resolve(msg)
      return
    }
    if (typeof msg.thrown === 'string') {
      p.reject(new UserError(thrownValueMessage('Project', p.configPath, msg.thrown)))
      return
    }
    // Rebuild the error the config actually threw. Name, message, stack
    // and a transpile error's position all survive the hop, so a broken
    // config reports the same text it would from an in-process import.
    const err = new Error(msg.message) as Error & { position?: WorkerReply['position'] }
    err.name = msg.name
    // A stackless throw stays stackless: the rebuilt Error's own stack names
    // this file, and `configLoadError` reads a stack naming no file as Bun's
    // JSON loader's.
    if (msg.stack !== null) err.stack = msg.stack
    else delete err.stack
    if (msg.position !== null) err.position = msg.position
    p.reject(err)
  }
  w.onerror = (event: ErrorEvent): void => {
    rejectAll(new Error(`config worker failed: ${String(event.message)}`))
  }
  // A reply that cannot be deserialized would otherwise leave its caller
  // awaiting forever — every path off this worker must settle its pending
  // promises, including the ones that carry no usable payload.
  w.addEventListener('messageerror', () => {
    rejectAll(new Error('config worker sent an undeserializable reply'))
  })
  worker = w
  return w
}

/**
 * Hold the round open across evaluations the caller runs one after another.
 * `loadProjectConfigs` awaits each repeat load in turn, so without this the
 * in-flight count reached zero after every config and each one paid for a
 * worker of its own: a round of 5 configs made 5 workers (item 694). The
 * worker is still created lazily, so a round that evaluates nothing costs
 * nothing, and it is retired when the round ends, so the next round starts
 * from an empty registry.
 */
export function beginEvalRound(): () => void {
  inFlight++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    retireIfIdle()
  }
}

function retireIfIdle(): void {
  inFlight--
  if (inFlight === 0 && worker !== null) {
    worker.terminate()
    worker = null
  }
}

/**
 * Evaluate `configPath` against a fresh module registry and return its
 * default export, JSON round-tripped. `null` means the module had no
 * object default export — the caller owns that error message so it
 * reads identically whichever path produced it. A default export holding
 * a value JSON cannot carry is refused here, with `validateProjectConfig`'s
 * message, since the round trip would have dropped the evidence.
 */
export async function evaluateConfigFresh(configPath: string): Promise<unknown> {
  const abs = path.resolve(configPath)
  const id = nextId++
  inFlight++
  // Declared out here so the `finally` can clear it on EVERY exit, including a
  // rejection. See the note at the clear itself.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const w = acquireWorker()
    // A worker thread the OS kills — memory pressure on a loaded CI box, a
    // hard crash — fires no `error` event, so without a deadline this await
    // never settles and `vx watch` hangs forever on a cycle that would
    // otherwise take milliseconds. Nothing else bounds it: there is no
    // run-level timeout. The budget is enormous next to the ~10 ms a real
    // evaluation costs, so it can only fire on a genuine wedge.
    const budget = evalBudgetMs()
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject, configPath })
      timer = setTimeout(() => {
        rejectAll(new Error(`config worker did not answer within ${budget}ms`))
        if (worker !== null) {
          worker.terminate()
          worker = null
        }
      }, budget)
      timer.unref?.()
      w.postMessage({ id, path: abs, env: { ...process.env } })
    })
    const [nonJson] = reply.nonJson
    if (nonJson !== undefined) throw new UserError(nonJsonMessage(configPath, nonJson))
    // A function stands in for the one the config exported, so the caller's
    // refusal names it as the in-process load's does.
    if (reply.json === null) return reply.fn === true ? FUNCTION_EXPORT : null
    return JSON.parse(reply.json) as unknown
  } finally {
    // In the `finally`, not after the await: a REJECTED evaluation — a config
    // with a typo, the common case while editing — would otherwise skip the
    // clear and leave its timer armed for the whole budget. When that orphan
    // later fired it ran `rejectAll()` and terminated whatever worker was
    // current by then, killing an unrelated healthy round with a timeout
    // message naming a budget nobody set for it.
    clearTimeout(timer)
    pending.delete(id)
    retireIfIdle()
  }
}

/**
 * What evaluating `configPath` alone changes among the watched built-ins
 * and env vars, in a worker of its own that is then discarded: a round
 * whose overlapping loads saw a change asks each config in turn, so the
 * refusal names the one that made it (D-119). Empty when the evaluation
 * changes nothing, fails before reporting, or outlives the budget.
 */
export async function builtinsChangedBy(configPath: string): Promise<string[]> {
  const w = new Worker(WORKER_URL)
  try {
    return await new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), evalBudgetMs())
      timer.unref?.()
      w.onmessage = (event: MessageEvent): void => {
        clearTimeout(timer)
        resolve((event.data as { changed?: string[] }).changed ?? [])
      }
      w.onerror = (): void => {
        clearTimeout(timer)
        resolve([])
      }
      w.postMessage({ id: 0, path: path.resolve(configPath), env: { ...process.env }, blame: true })
    })
  } finally {
    w.terminate()
  }
}
