import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { UserError, xxh3hex } from '../util/index.js'
import { validateProjectConfig, validateWorkspace } from './config-schema.js'
import { beginEvalRound, evaluateConfigFresh } from './config-eval.js'
import { hasEsmExport, unprovidedBareImports } from './config-imports.js'
import { configEvalKey, configEvalKeyFromClosure, type ConfigEvalStore } from './config-cache.js'
import { readOnce } from './load-reads.js'

// The validator lives in config-schema.ts; re-exported so a reader that
// reaches the loader for it (the tests do) keeps working.
export { validateProjectConfig }

/** The workspace config's filenames at the root, in lookup order. `vx watch` re-runs on an edit to whichever exists. */
export const WORKSPACE_CONFIG_FILENAMES = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
]

/** Project configs already loaded in this process, by absolute path. */
const loadedConfigs = new Set<string>()

function assertDefaultObject(mod: unknown, kind: string, configPath: string): void {
  if (!mod || typeof mod !== 'object') {
    throw new UserError(`${kind} config at ${configPath} did not export a default object`)
  }
}

/**
 * The source a load already holds, by the specifier it imports it under.
 * Bun's loader would open and read a project config a second time; the
 * `vx-config-bytes` plugin hands it this instead, so the evaluation runs
 * exactly the bytes the eval-cache key and the import gate saw. It is also
 * the cheaper load: 1,000 configs imported this way took 80–100 ms against
 * 180 ms read by Bun (measured 2026-09-24).
 *
 * Handed over as a string: `onLoad` reads a byte array as Latin-1, and a
 * `ü` in a description came back as `Ã¼`. So only UTF-8 is served, and
 * only ESM (`hasEsmExport`): source handed to `onLoad` is always evaluated
 * as a module, and a CommonJS config's `module.exports` would vanish. Any
 * other config takes Bun's own path, which reads the file and decides its
 * format as it always did. The two paths carry different queries because
 * `onLoad` cannot decline a path it matched.
 *
 * The workspace config is never served. Proving it ESM is the parser's
 * first use in a warm run, ~0.27 ms, and serving the one file saves less
 * than that: `loadWorkspaceConfig` measured 0.3 ms slower served (40
 * interleaved runs, 2026-09-24). Bun reads it a second time instead.
 */
const heldSources = new Map<string, string>()
let serving = false

function serveHeldSources(): void {
  if (serving) return
  serving = true
  Bun.plugin({
    name: 'vx-config-bytes',
    setup(build) {
      build.onLoad({ filter: /\?vx-held=[0-9a-f]+$/ }, (args) => ({
        contents: heldSources.get(args.path)!,
        loader: /\.[cm]?ts\?/.test(args.path) ? 'ts' : 'js',
      }))
    },
  })
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** `bytes` as the source `onLoad` may stand in for Bun's read with, or null (see `heldSources`). */
function servableSource(bytes: Uint8Array, loader: 'ts' | 'js'): string | null {
  let source: string
  try {
    source = utf8.decode(bytes)
  } catch {
    return null
  }
  return hasEsmExport(source, loader) ? source : null
}

/** vx's module-cache query, which no user wrote: stripped from anything shown to them. */
const BUST_QUERY = /\?vx-(?:bust|held)=[^'"\s]*/g

// Bun has native TS / ESM execution — no transpiler dep needed. We fold
// a short content hash into the import URL as a cache-bust key so that:
//   same content   → same URL → Bun's module cache hits (fast)
//   changed content → new URL → fresh re-evaluation (correct)
// mtime would be cheaper but Bun's stat().mtimeNs is currently undefined
// on Linux/macOS, and ms-resolution mtime misses rapid edits in tests.
// Hashing a typical <10 KB config file is ~50µs — not measurable next
// to the import() evaluation itself.
async function loadDefaultExport(
  configPath: string,
  kind: string,
  bytes: Uint8Array,
): Promise<unknown> {
  refuseUnprovidedImports(bytes, configPath, kind)
  // No random bust for `vx lock`: a project config reaches this import
  // only on its FIRST load in the process, so nothing is cached under the
  // URL yet, and a repeat load (the one that could replay an evaluation
  // made under earlier env values) re-evaluates in a worker instead
  // (`loadedConfigs`, item 678).
  const source =
    kind === 'Project' ? servableSource(bytes, /\.[cm]?ts$/.test(configPath) ? 'ts' : 'js') : null
  const specifier = `${configPath}?vx-${source !== null ? 'held' : 'bust'}=${xxh3hex(bytes)}`
  if (source !== null) {
    serveHeldSources()
    heldSources.set(specifier, source)
  }
  let ns: { default?: unknown }
  try {
    ns = (await import(specifier)) as { default?: unknown }
  } catch (err) {
    // A served module's frames name its specifier; the user wrote the path.
    if (err instanceof Error && err.stack !== undefined) {
      err.stack = err.stack.replaceAll(specifier, configPath)
    }
    throw configLoadError(err, configPath, kind) ?? err
  } finally {
    heldSources.delete(specifier)
  }
  const mod = ns?.default
  assertDefaultObject(mod, kind, configPath)
  return mod
}

/**
 * A bare import nothing above the config provides is refused BEFORE the
 * evaluation: left to Bun, a workspace with no `node_modules` would have
 * the package auto-installed from the registry first (config-imports.ts),
 * and a config must never download. The message keeps the shape Bun's own
 * refusal has, with the remedy.
 */
function refuseUnprovidedImports(bytes: Uint8Array, configPath: string, kind: string): void {
  const loader = /\.[cm]?ts$/.test(configPath) ? 'ts' : 'js'
  const missing = unprovidedBareImports(
    new TextDecoder().decode(bytes),
    path.dirname(configPath),
    loader,
  )
  if (missing.length === 0) return
  throw new UserError(
    `${kind} config ${configPath}: cannot find '${missing[0]}' — no node_modules above the config provides it; install the workspace's dependencies first`,
  )
}

/**
 * Where a transpile error was found. Bun's `BuildMessage` carries it as
 * `position`; the config worker forwards the same three fields (see
 * config-eval.ts) so the repeat path names the line too.
 */
interface BuildPosition {
  file?: string
  line?: number
  column?: number
}

/**
 * Turn the two errors Bun's own loader throws into user errors naming the
 * file the user wrote; every other throw is the config's own and already
 * carries its location in its stack, so it passes through unchanged.
 *
 * `ResolveMessage` — an import that cannot be resolved. The usual cause has
 * one answer: the workspace runs the vx binary and never installed `@vzn/vx`,
 * which its own `vx.workspace.ts` imports. Bun's message also carries the
 * module-cache bust query; the user gets the file they wrote.
 *
 * `BuildMessage` — a syntax or transpile error. Its message alone (`Expected
 * "}" but found end of file`) names no file at all, and the file is not
 * always the config: a preset the config imports fails the same way, so the
 * location is taken from the error's position, with the config as the
 * fallback.
 */
export function configLoadError(err: unknown, configPath: string, kind: string): UserError | null {
  // Matched on SHAPE, not `instanceof Error`. Bun's `BuildMessage` is not an
  // Error subclass on every build — on 1.3.11 its prototype chain is
  // `BuildMessage → Object` — and an `instanceof` guard there hands the user
  // a raw transpile object for a missing brace in their own config, which is
  // the defect `isFsRefusal` exists to prevent one layer down. The two names
  // below are Bun's own and nothing else answers to them, so this is
  // narrower than it looks: every other throw still passes through (2026-09-20).
  if (err === null || typeof err !== 'object') return null
  const { name, message } = err as { name?: unknown; message?: unknown }
  if (typeof message !== 'string') return null
  if (name === 'ResolveMessage') {
    const spec = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)?.[1]
    const what = spec === undefined ? message.replace(BUST_QUERY, '') : `cannot find '${spec}'`
    const hint =
      spec?.startsWith('@vzn/vx') === true
        ? `; install it in the workspace: bun add -d @vzn/vx`
        : ''
    return new UserError(`${kind} config ${configPath}: ${what}${hint}`)
  }
  if (name === 'BuildMessage') {
    const pos = (err as { position?: BuildPosition | null }).position ?? {}
    const file = typeof pos.file === 'string' && pos.file.length > 0 ? pos.file : configPath
    const at =
      typeof pos.line === 'number'
        ? `:${pos.line}${typeof pos.column === 'number' ? `:${pos.column}` : ''}`
        : ''
    const where = file === configPath ? `${configPath}${at}` : `${configPath} (in ${file}${at})`
    return new UserError(`${kind} config ${where}: ${message}`)
  }
  return null
}

export interface LoadProjectConfigOptions {
  /** Observe the CURRENT environment: no module-cache reuse, no eval cache. */
  fresh?: boolean
  /**
   * Serve a provably-pure config from its cached evaluation (see
   * config-cache.ts) and store a fresh one for next time. Off for `fresh`.
   */
  evalCache?: { store: ConfigEvalStore; workspaceFingerprint: string }
}

/**
 * Load many configs at once: every file's bytes and cache key in parallel,
 * ONE store lookup for all keys, then only the misses are evaluated (in the
 * order given, so a failure names the first broken file the way a
 * one-by-one load did). A single-path load is the one-element case.
 */
export async function loadProjectConfigs(
  configPaths: readonly string[],
  opts?: LoadProjectConfigOptions,
): Promise<ProjectConfig[]> {
  const evalCache = opts?.fresh === true ? undefined : opts?.evalCache
  const store = evalCache?.store
  const hashFile = store?.hashFile?.bind(store)
  const hashBytes = store?.hashBytes?.bind(store)
  // The slow path keys from the bytes it already holds; `hashFile` there
  // memoised every closure file one autocommit upsert at a time (item 615).
  const slowKeyHash =
    hashBytes !== undefined ? { hashBytes } : hashFile !== undefined ? { hashFile } : {}
  // The warm fast path: a config whose ordered closure the store remembers
  // is keyed from per-file identities (a stat each, no read, no scan); the
  // slow path below reads, gates and scans, and indexes the closure for
  // next time when every import is explicit.
  const closures =
    hashFile !== undefined && store?.getConfigClosures !== undefined
      ? store.getConfigClosures(configPaths)
      : new Map<string, string[]>()
  // Every indexed closure's files identified in ONE batch, then keyed from
  // the map; a file the batch could not stat has no identity, which makes
  // that config's fast key miss and sends it down the slow path exactly as
  // a throwing per-file `hashFile` did.
  let fastHashFile = hashFile
  if (closures.size > 0 && store?.hashFiles !== undefined) {
    const files = new Set<string>()
    for (const closure of closures.values()) for (const f of closure) files.add(f)
    const identities = await store.hashFiles([...files])
    fastHashFile = (file: string): Promise<string> => {
      const id = identities.get(file)
      return id === undefined
        ? Promise.reject(new Error(`no identity for ${file}`))
        : Promise.resolve(id)
    }
  }
  const prepared = await Promise.all(
    configPaths.map(async (configPath) => {
      const closure = closures.get(configPath)
      if (closure !== undefined && evalCache !== undefined && fastHashFile !== undefined) {
        const fastKey = await configEvalKeyFromClosure({
          closure,
          hashFile: fastHashFile,
          workspaceFingerprint: evalCache.workspaceFingerprint,
        })
        if (fastKey !== null) return { configPath, bytes: null, cacheKey: fastKey, indexed: true }
      }
      const bytes = await Bun.file(configPath).bytes()
      const keyed =
        evalCache === undefined
          ? null
          : await configEvalKey({
              configPath,
              bytes,
              workspaceFingerprint: evalCache.workspaceFingerprint,
              ...slowKeyHash,
            })
      return {
        configPath,
        bytes,
        cacheKey: keyed?.key ?? null,
        indexed: false,
        closure: keyed !== null && keyed.indexable ? keyed.closure : undefined,
      }
    }),
  )
  let hits = new Map<string, string>()
  if (evalCache !== undefined) {
    const keys = prepared.map((p) => p.cacheKey).filter((k): k is string => k !== null)
    if (keys.length > 0) {
      if (evalCache.store.getConfigEvals !== undefined) {
        hits = evalCache.store.getConfigEvals(keys)
      } else {
        for (const k of keys) {
          const hit = evalCache.store.getConfigEval(k)
          if (hit !== null) hits.set(k, hit)
        }
      }
    }
  }
  const out: ProjectConfig[] = []
  // What the round learned, written ONCE at the end: one transaction per
  // table where each evaluation was its own (1,000 configs cold: 100 ms of
  // autocommit inserts against 5, item 615). Written in `finally`, so a
  // config that fails validation costs the next attempt only its own
  // evaluation.
  const evals: Array<readonly [string, string]> = []
  const learnedClosures: Array<readonly [string, readonly string[]]> = []
  // One worker for every repeat load in this round, however many there are.
  const endRound = beginEvalRound()
  try {
    for (const entry of prepared) {
      const { configPath, cacheKey } = entry
      const hit = cacheKey === null ? undefined : hits.get(cacheKey)
      // Stored AFTER validation, so a hit needs none; the key covers every
      // byte the evaluation could have read.
      if (hit !== undefined) {
        out.push(JSON.parse(hit) as ProjectConfig)
        continue
      }
      // A fast key that missed: the closure is stale or the file changed.
      // Take the slow path for this one config, which re-indexes it.
      let bytes = entry.bytes
      let closure = entry.closure
      let key = cacheKey
      if (entry.indexed) {
        bytes = await Bun.file(configPath).bytes()
        const keyed = await configEvalKey({
          configPath,
          bytes,
          workspaceFingerprint: evalCache!.workspaceFingerprint,
          ...slowKeyHash,
        })
        key = keyed?.key ?? null
        closure = keyed !== null && keyed.indexable ? keyed.closure : undefined
        const slowHit = key === null ? null : (store!.getConfigEval(key) ?? null)
        if (slowHit !== null) {
          out.push(JSON.parse(slowHit) as ProjectConfig)
          if (closure !== undefined) learnedClosures.push([configPath, closure])
          continue
        }
      }
      // A REPEAT load in this process re-evaluates in a worker, because the
      // bust above cannot reach the config's import closure — see
      // config-eval.ts. A FIRST load keeps the in-process import, so the
      // single `vx run` hot path never pays for a worker.
      const repeat = loadedConfigs.has(configPath)
      loadedConfigs.add(configPath)
      if (repeat) refuseUnprovidedImports(bytes!, configPath, 'Project')
      const mod = repeat
        ? await evaluateConfigFresh(configPath).catch((err: unknown) => {
            throw configLoadError(err, configPath, 'Project') ?? err
          })
        : await loadDefaultExport(configPath, 'Project', bytes!)
      assertDefaultObject(mod, 'Project', configPath)
      // Validation runs HERE, on whichever object we ended up with, so a
      // malformed config reports the identical UserError whether it was
      // evaluated in-process or in a worker.
      validateProjectConfig(mod as ProjectConfig, configPath)
      if (key !== null) {
        evals.push([key, JSON.stringify(mod)])
        if (closure !== undefined) learnedClosures.push([configPath, closure])
      }
      out.push(mod as ProjectConfig)
    }
  } finally {
    endRound()
    if (store !== undefined) {
      if (evals.length > 0) {
        if (store.putConfigEvals !== undefined) store.putConfigEvals(evals)
        else for (const [k, json] of evals) store.putConfigEval(k, json)
      }
      if (learnedClosures.length > 0 && store.putConfigClosure !== undefined) {
        if (store.putConfigClosures !== undefined) store.putConfigClosures(learnedClosures)
        else for (const [p, files] of learnedClosures) store.putConfigClosure(p, files)
      }
    }
  }
  return out
}

export async function loadProjectConfig(
  configPath: string,
  opts?: LoadProjectConfigOptions,
): Promise<ProjectConfig> {
  const [config] = await loadProjectConfigs([configPath], opts)
  return config!
}

/**
 * Find and load `vx.workspace.{ts,mts,js,mjs}` from the workspace
 * root. Returns `null` if no such file exists (the common case;
 * the schema is fully optional). Validates the shape and throws
 * a `UserError` on malformed input.
 */
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig | null> {
  for (const configPath of WORKSPACE_CONFIG_FILENAMES.map((f) => path.join(root, f))) {
    const bytes = await readOnce(undefined, configPath)
    if (bytes === null) continue
    const mod = (await loadDefaultExport(configPath, 'Workspace', bytes)) as WorkspaceConfig
    validateWorkspace(mod, configPath)
    return mod
  }
  return null
}
