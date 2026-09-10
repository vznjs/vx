import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { UserError, xxh3hex } from '../util/index.js'
import { validateProjectConfig, validateWorkspace } from './config-schema.js'
import { evaluateConfigFresh } from './config-eval.js'
import { configEvalKey, configEvalKeyFromClosure, type ConfigEvalStore } from './config-cache.js'

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
  fresh = false,
  bytes?: Uint8Array,
): Promise<unknown> {
  bytes ??= await Bun.file(configPath).bytes()
  // `fresh` opts out of module-cache reuse entirely: `vx lock` and
  // `vx lock --check` must observe the CURRENT environment, and the
  // content-hash bust would replay an evaluation made under earlier
  // env values when the file bytes are unchanged in this process.
  const bust = fresh ? `${xxh3hex(bytes)}-${Bun.randomUUIDv7()}` : xxh3hex(bytes)
  let ns: { default?: unknown }
  try {
    ns = (await import(`${configPath}?vx-bust=${bust}`)) as { default?: unknown }
  } catch (err) {
    throw configLoadError(err, configPath, kind) ?? err
  }
  const mod = ns?.default
  assertDefaultObject(mod, kind, configPath)
  return mod
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
  if (!(err instanceof Error)) return null
  if (err.name === 'ResolveMessage') {
    const spec = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(err.message)?.[1]
    const what =
      spec === undefined ? err.message.replace(/\?vx-bust=\S+/g, '') : `cannot find '${spec}'`
    const hint =
      spec?.startsWith('@vzn/vx') === true
        ? `; install it in the workspace: bun add -d @vzn/vx`
        : ''
    return new UserError(`${kind} config ${configPath}: ${what}${hint}`)
  }
  if (err.name === 'BuildMessage') {
    const pos = (err as { position?: BuildPosition | null }).position ?? {}
    const file = typeof pos.file === 'string' && pos.file.length > 0 ? pos.file : configPath
    const at =
      typeof pos.line === 'number'
        ? `:${pos.line}${typeof pos.column === 'number' ? `:${pos.column}` : ''}`
        : ''
    const where = file === configPath ? `${configPath}${at}` : `${configPath} (in ${file}${at})`
    return new UserError(`${kind} config ${where}: ${err.message}`)
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
              ...(hashFile !== undefined ? { hashFile } : {}),
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
        ...(hashFile !== undefined ? { hashFile } : {}),
      })
      key = keyed?.key ?? null
      closure = keyed !== null && keyed.indexable ? keyed.closure : undefined
      const slowHit = key === null ? null : (store!.getConfigEval(key) ?? null)
      if (slowHit !== null) {
        out.push(JSON.parse(slowHit) as ProjectConfig)
        if (closure !== undefined) store!.putConfigClosure?.(configPath, closure)
        continue
      }
    }
    // A REPEAT load in this process re-evaluates in a worker, because the
    // bust above cannot reach the config's import closure — see
    // config-eval.ts. A FIRST load keeps the in-process import, so the
    // single `vx run` hot path never pays for a worker.
    const repeat = loadedConfigs.has(configPath)
    loadedConfigs.add(configPath)
    const mod = repeat
      ? await evaluateConfigFresh(configPath).catch((err: unknown) => {
          throw configLoadError(err, configPath, 'Project') ?? err
        })
      : await loadDefaultExport(configPath, 'Project', opts?.fresh === true, bytes!)
    assertDefaultObject(mod, 'Project', configPath)
    // Validation runs HERE, on whichever object we ended up with, so a
    // malformed config reports the identical UserError whether it was
    // evaluated in-process or in a worker.
    validateProjectConfig(mod as ProjectConfig, configPath)
    if (key !== null) {
      evalCache!.store.putConfigEval(key, JSON.stringify(mod))
      if (closure !== undefined) evalCache!.store.putConfigClosure?.(configPath, closure)
    }
    out.push(mod as ProjectConfig)
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
  let configPath: string | null = null
  for (const candidate of WORKSPACE_CONFIG_FILENAMES.map((f) => path.join(root, f))) {
    if (await Bun.file(candidate).exists()) {
      configPath = candidate
      break
    }
  }
  if (!configPath) return null
  const mod = (await loadDefaultExport(configPath, 'Workspace')) as WorkspaceConfig
  validateWorkspace(mod, configPath)
  return mod
}
