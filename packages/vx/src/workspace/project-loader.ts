import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { configThrow, isUserError, UserError, xxh3hex } from '../util/index.js'
import { isSkippedPlugin, validateProjectConfig, validateWorkspace } from './config-schema.js'
import {
  beginEvalRound,
  builtinsChangedBy,
  CONFIG_EXIT,
  evalBudgetMs,
  evaluateConfigFresh,
  thrownValueMessage,
  WATCHED_BUILTIN_NAMES,
} from './config-eval.js'
import { configImports, hasEsmExport, unprovidedBareImports } from './config-imports.js'
import { readOnce, unreadable } from './load-reads.js'
import { buildCompiled, loadCompiled, loadedModules } from './config-bytecode.js'

// The validator lives in config-schema.ts; re-exported so a reader that
// reaches the loader for it (the tests do) keeps working.
export { validateProjectConfig }

// The filenames live with the root lookup, which runs before anything loads.
import { WORKSPACE_CONFIG_FILENAMES, workspaceFile, workspaceRootOf } from '../handoff.js'
export { WORKSPACE_CONFIG_FILENAMES }

/** What a function default export is told. */
const EXPORTED_A_FUNCTION =
  'it exports a function, and vx reads the object itself — export what the function returns'

/** Project configs already loaded in this process, by absolute path. */
const loadedConfigs = new Set<string>()

function assertDefaultObject(mod: unknown, kind: string, configPath: string): void {
  if (!mod || typeof mod !== 'object') {
    // Vite's `defineConfig(() => ({ … }))` shape: vx reads the object, and
    // the bare refusal did not say what was there instead (D-110).
    throw new UserError(
      `${kind} config at ${configPath} did not export a default object` +
        (typeof mod === 'function' ? `: ${EXPORTED_A_FUNCTION}` : ''),
    )
  }
}

/**
 * The source a load already holds, by the specifier it imports it under.
 * Bun's loader would open and read a project config a second time; the
 * `vx-config-bytes` plugin hands it this instead, so the evaluation runs
 * exactly the bytes the import gate saw. It is also the cheaper load:
 * 1,000 configs imported this way took 80–100 ms against 180 ms read by
 * Bun (measured 2026-09-24).
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
//
// Held by the bytes' hash, not the specifier: Bun hands `onLoad` the path
// it RESOLVED, which is the real path, so a config reached through a
// symlinked directory (macOS's `/var` → `/private/var`, every temp root
// there) came back under a key nobody set, and every such load failed.
// Equal hashes are equal sources, so two loads of the same bytes share an
// entry; `uses` keeps it until the last of them has imported.
const heldSources = new Map<string, { source: string; uses: number }>()
let serving = false

const HELD_QUERY = /\?vx-(?:held|literal)=([0-9a-f]+)$/

// Bun's resolver reads `\` as a separator, even in a file: URL, so a
// config under `a\b` was looked for under `a/b`, and `?` as a query, so
// one under `a?b` was looked for under `a`. Resolving it here keeps the
// path as written; only the served load can take it.
const LITERAL_QUERY = /\?vx-literal=[0-9a-f]+$/

function serveHeldSources(): void {
  if (serving) return
  serving = true
  Bun.plugin({
    name: 'vx-config-bytes',
    setup(build) {
      build.onResolve({ filter: LITERAL_QUERY }, (args) => ({ path: args.path, namespace: 'file' }))
      build.onLoad({ filter: HELD_QUERY }, (args) => ({
        contents: heldSources.get(HELD_QUERY.exec(args.path)![1]!)!.source,
        loader: /\.[cm]?ts\?/.test(args.path) ? 'ts' : 'js',
      }))
      build.onLoad({ filter: PLAIN_CONFIG }, (args) => {
        const loader = /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js'
        const held = heldPaths.get(args.path) ?? heldByRealPath(args.path)
        if (held !== undefined) {
          held.served = true
          return { contents: heldSources.get(held.hash)!.source, loader }
        }
        // A config no load holds now, imported by another module. `onLoad`
        // cannot decline it, so it is served as Bun reads it, and what
        // `onLoad` cannot carry (CommonJS, not UTF-8) is Bun's own load.
        const bytes = readFileSync(args.path)
        const source = servableSource(bytes, loader)
        if (source !== null) return { contents: source, loader }
        const native = JSON.stringify(`${args.path}?vx-bust=${xxh3hex(bytes)}`)
        return {
          contents: `import * as m from ${native}\nexport * from ${native}\nexport default m.default\n`,
          loader: 'js',
        }
      })
    },
  })
}

function holdSource(hash: string, source: string, plain: Held | null, configPath: string): void {
  const held = heldSources.get(hash)
  if (held === undefined) heldSources.set(hash, { source, uses: 1 })
  else held.uses++
  if (plain !== null) heldPaths.set(configPath, plain)
}

function releaseSource(hash: string, plain: Held | null, configPath: string): void {
  const held = heldSources.get(hash)!
  if (--held.uses === 0) heldSources.delete(hash)
  if (plain !== null) heldPaths.delete(configPath)
}

// Served under `?vx-held=`, a config was a second module beside the plain
// path an import cycle reaches back to, and its `import.meta.url` carried
// the query, unlike the worker's. So it is imported under its own path,
// and `served` says whether this load's bytes were what Bun evaluated:
// unset, the registry held the path already (a config another imported,
// maybe older bytes), and only a query evaluates afresh.
interface Held {
  hash: string
  served: boolean
  /** Learned only when `onLoad` misses: Bun hands it the real path. */
  real?: string | null
}
const heldPaths = new Map<string, Held>()

const PLAIN_CONFIG = /[\\/]vx\.config\.[cm]?[jt]s$/

// A realpath for every config was 7–10 ms on 1,000 (2026-10-28); only a
// path reached through a link misses, so only a miss pays it.
function heldByRealPath(real: string): Held | undefined {
  for (const [configPath, held] of heldPaths) {
    if (held.real === undefined) {
      try {
        held.real = realpathSync(configPath)
      } catch {
        held.real = null
      }
    }
    if (held.real === real) return held
  }
  return undefined
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
  return !COMMONJS_HINT.test(source) || hasEsmExport(source, loader) ? source : null
}

// What makes Bun run a file as CommonJS is one of these names at the top
// level (an escaped `\u006dodule` too, so any backslash counts), or
// TypeScript's `export =`, which spells none of them. Source
// with none of them runs as a module whichever path loads it, so it skips
// the parse: 16–20 µs a config, 1,000 cold configs (2026-10-03).
const COMMONJS_HINT =
  /\b(?:module|exports|require|this|__dirname|__filename)\b|\\|\bexport\s*=(?!=)/

/** vx's module-cache query, which no user wrote: stripped from anything shown to them. */
const BUST_QUERY = /\?vx-(?:bust|held|literal)=[^'"\s]*/g

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
  /** The workspace root, where the load may run the config's bytecode bundle (config-bytecode.ts). */
  compiledRoot?: string,
  /** File texts read for the refusal, kept across one load's configs. */
  reads = new Map<string, Promise<string>>(),
): Promise<unknown> {
  const text = new TextDecoder().decode(bytes)
  refuseUnprovided(text, configPath, configPath, kind)
  // No random bust for `vx lock`: a project config reaches this import
  // only on its FIRST load in the process, so nothing is cached under the
  // URL yet, and a repeat load (the one that could replay an evaluation
  // made under earlier env values) re-evaluates in a worker instead
  // (`loadedConfigs`, item 678).
  const literal = /[\\?]/.test(configPath)
  const source =
    kind === 'Project' || literal
      ? servableSource(bytes, /\.[cm]?ts$/.test(configPath) ? 'ts' : 'js')
      : null
  if (literal && source === null) {
    throw new UserError(
      `${kind} config ${configPath} sits under a path that holds ${configPath.includes('\\') ? 'a backslash' : 'a question mark'}, which Bun loads only as an ES module in UTF-8`,
    )
  }
  const hash = xxh3hex(bytes)
  const plain: Held | null =
    source !== null && !literal && PLAIN_CONFIG.test(configPath) ? { hash, served: false } : null
  const specifier = `${configPath}?vx-${literal ? 'literal' : source !== null ? 'held' : 'bust'}=${hash}`
  if (source !== null) {
    serveHeldSources()
    holdSource(hash, source, plain, configPath)
  }
  let ns: { default?: unknown }
  let compiled: { default?: unknown } | null | undefined
  let loaded: Set<string> | undefined
  const unguard = guardExit()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    // A bundle that throws is evaluated from source below, so the error
    // the user sees is the source's.
    compiled =
      literal || compiledRoot === undefined ? null : tryCompiled(compiledRoot, configPath, bytes)
    if (compiled) return defaultOf(compiled, kind, configPath)
    if (compiled === undefined) loaded = loadedModules(compiledRoot!)
    // The worker's budget, here too: a top-level await that never settled
    // while a timer kept the loop alive hung `vx run` for good, silently
    // (D-66).
    await refuseUnprovidedClosure(text, configPath, kind, reads)
    const budget = evalBudgetMs()
    ns = (await Promise.race([
      plain === null
        ? import(specifier)
        : import(configPath).then(
            (ns: unknown) => (plain.served ? ns : import(specifier)),
            (err: unknown) => {
              if (plain.served) throw err
              return import(specifier)
            },
          ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new UserError(
                `${kind} config ${configPath} did not finish evaluating within ${budget}ms (VX_CONFIG_WORKER_TIMEOUT)`,
              ),
            ),
          budget,
        )
      }),
    ])) as { default?: unknown }
  } catch (err) {
    // A served module's frames name its specifier; the user wrote the path.
    if (err instanceof Error && err.stack !== undefined) {
      err.stack = err.stack.replaceAll(specifier, configPath).replace(BUST_QUERY, '')
    }
    throw loadFailure(err, configPath, kind)
  } finally {
    clearTimeout(deadline)
    unguard()
    if (source !== null) releaseSource(hash, plain, configPath)
  }
  const mod = defaultOf(ns, kind, configPath)
  if (compiledRoot !== undefined && loaded !== undefined) {
    await buildCompiled(compiledRoot, configPath, bytes, loaded, ns)
  }
  return mod
}

function defaultOf(ns: { default?: unknown }, kind: string, configPath: string): unknown {
  const mod = ns?.default
  assertDefaultObject(mod, kind, configPath)
  return mod
}

/** The bundle's namespace; `undefined` to build one after this load, `null` when none can serve. */
function tryCompiled(
  root: string,
  configPath: string,
  bytes: Uint8Array,
): { default?: unknown } | null | undefined {
  try {
    return loadCompiled(root, configPath, bytes)
  } catch {
    return null
  }
}

/**
 * A config's `process.exit` ended vx mid-load: `exit(0)` was a green run
 * that ran nothing and printed nothing (D-65). While any config evaluates
 * in process it throws instead, at the config's line. vx's own exit is
 * signal forwarding's, which a run installs after its load and removes
 * when it ends.
 */
let evaluating = 0
let ownExit: typeof process.exit = process.exit
function guardExit(): () => void {
  if (evaluating++ === 0) {
    ownExit = process.exit
    process.exit = configExit
  }
  return () => {
    if (--evaluating === 0) process.exit = ownExit
  }
}
const configExit = ((code?: number | string | null) => {
  throw new Error(`process.exit(${code ?? ''}) in a config: ${CONFIG_EXIT}`)
}) as typeof process.exit

/** A `.pnp.cjs` in `dir` or above: Yarn Plug'n'Play's install. */
function pnpAbove(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.pnp.cjs'))) return true
    if (path.dirname(d) === d) return false
  }
}

/**
 * A bare import nothing above the config provides is refused BEFORE the
 * evaluation: left to Bun, a workspace with no `node_modules` would have
 * the package auto-installed from the registry first (config-imports.ts),
 * and a config must never download. The message keeps the shape Bun's own
 * refusal has, with the remedy.
 */
/** `source` is `file`'s: the config's own, or one it reaches. */
function refuseUnprovided(source: string, file: string, configPath: string, kind: string): void {
  const loader = /\.[cm]?tsx?$/.test(file) ? 'ts' : 'js'
  const missing = unprovidedBareImports(source, path.dirname(file), loader)
  if (missing.length === 0) return
  const own = file === configPath
  const what = own
    ? `cannot find '${missing[0]}'`
    : `${file} imports '${missing[0]}', which no node_modules above it provides`
  // Under Yarn Plug'n'Play the dependencies ARE installed, into a
  // `.pnp.cjs` Bun does not read: "install them first" sent the user to a
  // `yarn install` that changed nothing (D-109).
  if (pnpAbove(path.dirname(file))) {
    throw new UserError(
      `${kind} config ${configPath}: ${what} — Yarn Plug'n'Play installed the workspace's dependencies into .pnp.cjs, which Bun does not read; set \`nodeLinker: node-modules\` in .yarnrc.yml and run \`yarn install\``,
    )
  }
  throw new UserError(
    `${kind} config ${configPath}: ${what}${own ? ' — no node_modules above the config provides it' : ''}; install the workspace's dependencies first`,
  )
}

const RELATIVE_IMPORT = /["']\.\.?\//
const SCRIPT = /\.[cm]?[jt]sx?$/

/**
 * The same refusal for each script the config reaches by relative import:
 * a preset's bare import was installed and run where the config's own was
 * refused (L-22; `--no-install` holds only the shebang, not `bun src/bin.ts`
 * or an embedder). Only a source evaluation pays: a fresh bundle resolved
 * every import it holds. `reads` keeps each file's text for the load's other
 * configs: a preset a thousand configs share is read once.
 */
async function refuseUnprovidedClosure(
  source: string,
  configPath: string,
  kind: string,
  reads: Map<string, Promise<string>>,
): Promise<void> {
  if (!RELATIVE_IMPORT.test(source)) return
  const read = (file: string): Promise<string> => {
    let text = reads.get(file)
    if (text === undefined) reads.set(file, (text = Bun.file(file).text()))
    return text
  }
  for (const file of await configImports(configPath, source, read)) {
    if (!SCRIPT.test(file)) continue
    const text = await read(file).catch(() => null)
    if (text !== null) refuseUnprovided(text, file, configPath, kind)
  }
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

/** A stack frame naming a file path, as a config's own throw has. */
const NAMED_FRAME = /\n\s+at .*[\\/]/

/**
 * Turn the two errors Bun's own loader throws into user errors naming the
 * file the user wrote; every other throw is the config's own and already
 * carries its location in its stack, so it passes through unchanged.
 *
 * `ResolveMessage` — an import that cannot be resolved. The usual cause has
 * one answer: the workspace runs the vx binary and never installed `@vzn/vx`,
 * which its own `.vx/workspace.ts` imports. Bun's message also carries the
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
  const { name, message, errors } = err as { name?: unknown; message?: unknown; errors?: unknown }
  // Two syntax errors arrive as one `AggregateError` of `BuildMessage`s,
  // which printed a stack and no position (X-6). The first is where to look.
  if (name === 'AggregateError' && Array.isArray(errors) && errors.length > 0) {
    return configLoadError(errors[0], configPath, kind)
  }
  if (typeof message !== 'string') return null
  // Bun's JSON loader throws a `SyntaxError` whose stack, when it has one,
  // holds no file frame: a malformed `import data from './data.json'`
  // printed `vx: JSON Parse error: Expected '}'` and named nothing. A
  // config's own `JSON.parse` has its line in the stack and passes through.
  if (name === 'SyntaxError' && !NAMED_FRAME.test(String((err as { stack?: unknown }).stack))) {
    return new UserError(`${kind} config ${configPath}: an import does not parse: ${message}`)
  }
  if (name === 'ResolveMessage') {
    const spec = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)?.[1]
    const what = spec === undefined ? message.replace(BUST_QUERY, '') : `cannot find '${spec}'`
    // The package the specifier names (`@vzn/vx-otel/x` → `@vzn/vx-otel`):
    // a missing plugin was told to install core (J-59).
    const hint =
      spec?.startsWith('@vzn/vx') === true
        ? `; install it in the workspace: bun add -d ${spec.split('/').slice(0, 2).join('/')}`
        : ''
    return new UserError(`${kind} config ${configPath}: ${what}${hint}`)
  }
  if (name === 'BuildMessage') {
    const pos = (err as { position?: BuildPosition | null }).position ?? {}
    // A served config's position names its specifier, query and all.
    const file =
      typeof pos.file === 'string' && pos.file.length > 0
        ? pos.file.replace(BUST_QUERY, '')
        : configPath
    const at =
      typeof pos.line === 'number'
        ? `:${pos.line}${typeof pos.column === 'number' ? `:${pos.column}` : ''}`
        : ''
    const where = file === configPath ? `${configPath}${at}` : `${configPath} (in ${file}${at})`
    return new UserError(`${kind} config ${where}: ${message}`)
  }
  return null
}

/** What a failed load throws: Bun's own errors and non-Error throws as user errors, the rest as thrown. */
function loadFailure(err: unknown, configPath: string, kind: string): unknown {
  const user = configLoadError(err, configPath, kind)
  if (user !== null) return user
  if (err !== null && typeof err === 'object' && typeof (err as Error).message === 'string') {
    return isUserError(err) ? err : configThrow(err)
  }
  return new UserError(thrownValueMessage(kind, configPath, Bun.inspect(err, { compact: true })))
}

/**
 * More than one config refused in one load: the first is the error, and
 * `all` names each. A rename after an upgrade refuses every config at once,
 * and naming one a run made a 200-config repo take 200 runs.
 */
export class ConfigsRefused extends UserError {
  constructor(readonly all: readonly UserError[]) {
    super(all[0]!.message, all[0]!.code)
    if (all[0]!.parts !== undefined) this.parts = all[0]!.parts
  }
}

/**
 * Evaluate many configs at once: every file's bytes in parallel, then each
 * one evaluated (in the order given, so a failure names the first broken
 * file the way a one-by-one load did). A single-path load is the
 * one-element case. Only `vx lock` evaluates; every run reads the lock.
 */
const LOAD_WIDTH = 128

export async function loadProjectConfigs(configPaths: readonly string[]): Promise<ProjectConfig[]> {
  const prepared = await Promise.all(
    configPaths.map(async (configPath) => ({
      configPath,
      bytes: await Bun.file(configPath)
        .bytes()
        .catch((err: unknown) => unreadable(err, configPath)),
    })),
  )
  let builtins: BuiltinSnapshot | undefined
  let env: Readonly<Record<string, string | undefined>> = {}
  let cwd = ''
  let umask = -1
  let unredirect: (() => void) | undefined
  // More than one evaluation in flight: a change seen after one load may
  // be another's.
  let overlapping = false
  const reads = new Map<string, Promise<string>>()
  const loadOne = async (entry: (typeof prepared)[number]): Promise<ProjectConfig> => {
    const { configPath, bytes } = entry
    // A REPEAT load in this process re-evaluates in a worker, because the
    // bust above cannot reach the config's import closure — see
    // config-eval.ts. A FIRST load keeps the in-process import.
    const repeat = loadedConfigs.has(configPath)
    loadedConfigs.add(configPath)
    if (repeat) {
      const text = new TextDecoder().decode(bytes)
      refuseUnprovided(text, configPath, configPath, 'Project')
      await refuseUnprovidedClosure(text, configPath, 'Project', reads)
    }
    const mod = repeat
      ? await evaluateConfigFresh(configPath).catch((err: unknown) => {
          throw loadFailure(err, configPath, 'Project')
        })
      : await loadDefaultExport(configPath, 'Project', bytes, undefined, reads)
    // Before anything reads through them: a replaced `Array.prototype.includes`
    // turned the JSON-data walk's own check into "a cyclic reference".
    const changed = repeat
      ? []
      : [
          ...restoreBuiltins(builtins, overlapping),
          // Overlapping, the env is checked once at the round's end, as most
          // built-ins are: reading all of it after every load was 15–25 µs a
          // config (149 variables, compiled, 2026-10-03).
          ...(overlapping ? [] : restoreEnv(env)),
          ...restoreCwd(cwd),
          // Alone in the round: nothing else reads the umask now. Beside
          // other loads the round reads it once they are done (see
          // `currentUmask`).
          ...(overlapping ? [] : restoreUmask(umask)),
        ]
    // Loads overlap, so another config's change can surface after this
    // one: named here, the refusal blamed the wrong file (D-119). The round
    // finds the one that made it.
    if (changed.length > 0) {
      throw overlapping ? new ChangedInRound(changed) : builtinsChanged(changed, configPath)
    }
    assertDefaultObject(mod, 'Project', configPath)
    // Validation runs HERE, on whichever object we ended up with, so a
    // malformed config reports the identical UserError whether it was
    // evaluated in-process or in a worker.
    validateProjectConfig(mod as ProjectConfig, configPath)
    // A tree of its own, as the lock hands out. The module object shares
    // what the config shares: one preset's task in two configs, one `exec`
    // in two tasks. A `project` hook that edits in place then edited them
    // all (item 967). A config is JSON data (config-schema.ts), so the copy
    // loses nothing.
    return JSON.parse(JSON.stringify(mod)) as ProjectConfig
  }
  // One worker for every repeat load in this round, however many there are.
  const endRound = beginEvalRound()
  try {
    // Loaded LOAD_WIDTH at a time: one import after another put 1,000 cold
    // configs at ~160 ms of imports where 64 at once take ~60 (D-68), and
    // 128 took `load configs` from 432 to 411 ms more; the width bounds the
    // files a module load may hold open, so it stays under macOS's default
    // 256-descriptor limit. A failure stops nothing; the error thrown is
    // the first in order, as the serial loop's was.
    const results: Array<ProjectConfig | { failed: unknown }> = []
    if (prepared.length > 0) {
      unredirect = stdoutToStderr()
      builtins = builtinSnapshot()
      env = { ...process.env }
      cwd = process.cwd()
      umask = currentUmask()
    }
    overlapping = prepared.length > 1
    let next = 0
    const lane = async (): Promise<void> => {
      while (next < prepared.length) {
        const i = next++
        results[i] = await loadOne(prepared[i]!).catch((err: unknown) => ({ failed: err }))
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOAD_WIDTH, prepared.length) }, lane))
    let first: { failed: unknown } | undefined
    for (const r of results) if ('failed' in r) first ??= r
    const changed =
      prepared.length > 0
        ? [
            ...restoreBuiltins(builtins),
            ...restoreEnv(env),
            ...restoreCwd(cwd),
            ...restoreUmask(umask),
          ]
        : []
    // Overlapping loads check most built-ins and the env only here, so a
    // change one config made may have broken another's load: it is refused
    // first.
    const changedInRound =
      first?.failed instanceof ChangedInRound
        ? first.failed.changed
        : overlapping && changed.length > 0
          ? changed
          : undefined
    if (changedInRound !== undefined) {
      for (const { configPath } of prepared) {
        const own = await builtinsChangedBy(configPath)
        // The blaming worker is gone, so this thread reads alone; and a
        // worker that outlived its budget was ended before it could put
        // the umask back.
        restoreUmask(umask)
        if (own.length > 0) throw builtinsChanged(own, configPath)
      }
      throw builtinsChanged(changedInRound)
    }
    if (first !== undefined) {
      const refused = results.flatMap((r) =>
        'failed' in r && isUserError(r.failed) ? [r.failed] : [],
      )
      throw refused.length > 1 && refused[0] === first.failed
        ? new ConfigsRefused(refused)
        : first.failed
    }
    // One load in the round, in the worker (a repeat load), is the one
    // that moved it: the worker no longer reads the umask to say so.
    if (changed.length > 0)
      throw builtinsChanged(changed, prepared.length === 1 ? prepared[0]!.configPath : undefined)
    return results as ProjectConfig[]
  } finally {
    unredirect?.()
    endRound()
  }
}

/**
 * Every route to fd 1 sent to stderr while configs evaluate in this
 * process; returns the release. A verb's stdout is its output (`vx show
 * --format json`), and a config's `console.log` came out ahead of the
 * JSON. The worker does the same for a repeat load (D-64). Taken before a round's built-in snapshot and released
 * after its check, so the guard sees no change of vx's own.
 *
 * Counted, because rounds overlap (`--affected`'s per-file sweep loads each
 * config in a round of its own): a second install over the first moved
 * `Bun.write` and `console` under the first round's snapshot, which refused
 * the loads, and the undos ran out of order and left a redirect in place
 * for good. The first taker installs; the last release restores.
 */
let redirectHolders = 0
let undoRedirect = (): void => {}
/**
 * Bun's own console, taken at load: the console a round finds may be a
 * constructed one (a plugin's verb may install its own), which has no
 * `Console`.
 */
const bunConsole = globalThis.console as typeof console & { Console?: typeof console.Console }
let stderrConsole: typeof console | undefined
const BUILT_ON_READ: ReadonlySet<PropertyKey> = new Set(['Console', '_stdout', '_stderr'])

/**
 * A console that writes to stderr, built on the first call: reading
 * `Console` loads `node:console`, ~4 ms of a warm run, and the workspace
 * config each run loads in a redirect seldom prints.
 */
function redirectedConsole(): typeof console {
  const real = (): Record<PropertyKey, (...a: unknown[]) => unknown> =>
    (stderrConsole ??= Object.assign(new bunConsole.Console!(process.stderr, process.stderr), {
      // Bun's console adds `write`, which a constructed Console lacks.
      write: (...data: string[]) => {
        const text = data.join('')
        process.stderr.write(text)
        return text.length
      },
    })) as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>
  const facade = {}
  for (const key of [...Reflect.ownKeys(bunConsole), 'write']) {
    // Read through the real one when read: even their descriptors build a
    // module or a stream (~17 ms together, Bun 1.4.2).
    if (BUILT_ON_READ.has(key)) {
      Object.defineProperty(facade, key, { get: () => real()[key], configurable: true })
      continue
    }
    const own = Object.getOwnPropertyDescriptor(bunConsole, key)
    Object.defineProperty(
      facade,
      key,
      own === undefined || typeof own.value === 'function'
        ? {
            value: (...args: unknown[]) => real()[key]!(...args),
            writable: true,
            configurable: true,
          }
        : own,
    )
  }
  return facade as typeof console
}

function stdoutToStderr(): () => void {
  if (redirectHolders++ === 0) undoRedirect = installRedirect()
  return () => {
    if (--redirectHolders === 0) undoRedirect()
  }
}

function installRedirect(): () => void {
  const out = process.stdout
  const ownWrite = Object.getOwnPropertyDescriptor(out, 'write')
  const ownConsole = globalThis.console
  const bun = Bun as { write: typeof Bun.write }
  const ownBunWrite = Bun.write
  const ownWriter = Object.getOwnPropertyDescriptor(Bun.stdout, 'writer')
  out.write = ((...args: Parameters<typeof process.stderr.write>) =>
    process.stderr.write(...args)) as typeof out.write
  bun.write = ((dest: unknown, ...rest: unknown[]) =>
    (ownBunWrite as (...a: unknown[]) => Promise<number>)(
      dest === Bun.stdout ? Bun.stderr : dest,
      ...rest,
    )) as typeof Bun.write
  ;(Bun.stdout as { writer: typeof Bun.stdout.writer }).writer = ((
    ...args: Parameters<typeof Bun.stderr.writer>
  ) => Bun.stderr.writer(...args)) as typeof Bun.stdout.writer
  globalThis.console = redirectedConsole()
  return () => {
    if (ownWrite === undefined) delete (out as { write?: unknown }).write
    else Object.defineProperty(out, 'write', ownWrite)
    bun.write = ownBunWrite
    if (ownWriter === undefined) delete (Bun.stdout as { writer?: unknown }).writer
    else Object.defineProperty(Bun.stdout, 'writer', ownWriter)
    globalThis.console = ownConsole
  }
}

/**
 * The built-in prototypes a config's object is read through. A config that
 * set `Object.prototype.exec` gave every other project's task that
 * command, and the key, which folds each config's own JSON, never saw it:
 * a hit replayed under a key that did not name what ran (D-74). A first
 * load runs in this process, so the round compares them before and after,
 * puts back what changed (a failed load too) and refuses.
 */
// `Bun` and `Bun.hash` are what vx itself runs on: `Bun.hash.xxHash3 = ()
// => 7n` gave every task the key 00000000, and a changed command replayed
// the old output (D-75).
const WATCHED_BUILTINS: ReadonlyArray<readonly [string, object]> = WATCHED_BUILTIN_NAMES.map(
  (name) =>
    [
      name,
      name
        .split('.')
        .reduce<unknown>(
          (o, k) => (o === globalThis && k === 'Bun' ? Bun : (o as Record<string, unknown>)[k]),
          globalThis,
        ) as object,
    ] as const,
)

// The check reads through these, taken when a round's snapshot is, before
// any of its configs runs: a config that set `Reflect.ownKeys = () => []`
// blinded it, and its `Object.prototype.exec` ran in another project's
// task (D-124). Each round keeps its own, so an overlapping round cannot
// hand it a replaced one. The compare and put-back use indexed loops only
// (a replaced `Array.prototype.forEach` skipped them).
interface Primitives {
  ownKeys: typeof Reflect.ownKeys
  descriptorOf: typeof Object.getOwnPropertyDescriptor
  defineOwn: typeof Object.defineProperty
  deleteOwn: typeof Reflect.deleteProperty
  hasOwn: typeof Object.hasOwn
  same: typeof Object.is
  keyName: typeof String
}

interface OwnProperties {
  keys: PropertyKey[]
  descriptors: PropertyDescriptor[]
}

interface BuiltinSnapshot {
  readonly prims: Primitives
  /** Undefined for a watched name the snapshot leaves out. */
  readonly props: readonly (OwnProperties | undefined)[]
}

/**
 * The members of `Bun` vx reads, which the workspace config's guard checks;
 * of the rest it keeps the keys and their order, not their descriptors.
 * Some members are built on their first read (`postgres` loaded `bun:sql`,
 * 3.4 ms), and the guard runs on every warm run, where its full read of
 * `Bun` was 4.4–5 ms of a 45 ms no-op (compiled, 2026-10-03). A project
 * config's guard reads them all. Held to every `Bun.<name>` in `src/` by
 * tests/workspace-guard-bun.test.ts.
 */
const BUN_MEMBERS_VX_READS: readonly PropertyKey[] = [
  'Archive',
  'BuildMetafile',
  'BunFile',
  'CryptoHasher',
  'Glob',
  'JSONC',
  'Subprocess',
  'TOML',
  'Transpiler',
  'build',
  'color',
  'deepEquals',
  'env',
  'file',
  'gunzipSync',
  'hash',
  'inspect',
  'main',
  'nanoseconds',
  'pathToFileURL',
  'plugin',
  'randomUUIDv7',
  'resolveSync',
  'revision',
  'secrets',
  'serve',
  'sleep',
  'sleepSync',
  'spawn',
  'spawnSync',
  'stderr',
  'stdout',
  'stringWidth',
  'stripANSI',
  'version',
  'which',
  'write',
  'zstdCompress',
  'zstdCompressSync',
  'zstdDecompress',
  'zstdDecompressSync',
]

/** A descriptor the snapshot did not read. */
const UNREAD: PropertyDescriptor = Object.freeze({})

function builtinSnapshot(leaveOut?: string, onlyBunMembersVxReads = false): BuiltinSnapshot {
  const prims: Primitives = {
    ownKeys: Reflect.ownKeys,
    descriptorOf: Object.getOwnPropertyDescriptor,
    defineOwn: Object.defineProperty,
    deleteOwn: Reflect.deleteProperty,
    hasOwn: Object.hasOwn,
    same: Object.is,
    keyName: String,
  }
  const props: (OwnProperties | undefined)[] = []
  for (let i = 0; i < WATCHED_BUILTINS.length; i++) {
    if (WATCHED_BUILTINS[i]![0] === leaveOut) {
      props[i] = undefined
      continue
    }
    const proto = WATCHED_BUILTINS[i]![1]
    const keys = prims.ownKeys(proto)
    const descriptors: PropertyDescriptor[] = []
    const narrow = onlyBunMembersVxReads && proto === Bun
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!
      descriptors[j] =
        narrow && !BUN_MEMBERS_VX_READS.includes(key) ? UNREAD : prims.descriptorOf(proto, key)!
    }
    props[i] = { keys, descriptors }
  }
  return { prims, props }
}

/**
 * The same keys in the same order with the same descriptors: nothing to
 * put back. Read by position, without the by-key lookups and the second
 * pass for deleted keys, it is the cold path's common case once per
 * evaluated config: the full check was ~0.1 ms a config, ~100 ms of a
 * 1,000-config cold load.
 */
function unchanged(
  p: Primitives,
  proto: object,
  keys: readonly PropertyKey[],
  was: OwnProperties,
): boolean {
  if (keys.length !== was.keys.length) return false
  for (let j = 0; j < keys.length; j++) {
    const key = keys[j]!
    if (key !== was.keys[j]) return false
    const prior = was.descriptors[j]!
    if (prior === UNREAD) continue
    if (!sameDescriptor(p, prior, p.descriptorOf(proto, key)!)) return false
  }
  return true
}

/** A change seen by one of several overlapping loads; the round names its config. */
class ChangedInRound {
  constructor(readonly changed: readonly string[]) {}
}

/** Without `configPath`, no config alone was found to make the change. */
function builtinsChanged(changed: readonly string[], configPath?: string): UserError {
  const who = configPath === undefined ? 'a project config' : configPath
  const env =
    (changed.some((c) => c.startsWith('process.env.'))
      ? '; a task gets an env var through `exec.env.define` or `passThrough`'
      : '') +
    (changed.some((c) => c.startsWith('process.cwd'))
      ? '; a task runs in its project directory, and `cd <dir> && …` in `exec.command` moves it'
      : '') +
    (changed.some((c) => c.startsWith('process.umask'))
      ? '; a task sets its own with `umask <mode> && …` in `exec.command`'
      : '') +
    (changed.some((c) => c.startsWith('globalThis.'))
      ? '; a constant configs share goes in a module each one imports'
      : '')
  return new UserError(
    `${who} changed ${changed.join(', ')} while it was evaluated — a config must not change the built-ins vx runs on: other configs are read through them and cache keys are made with them${env}`,
  )
}

/**
 * The built-ins checked after each of several overlapping loads: the ones
 * the loader itself reads through between loads (its promises, maps, sets,
 * JSON and keys). The rest are checked once, at the round's end: all of
 * them after every load was ~73 µs a config, a quarter of a cold load of
 * 1,000 (2026-10-03). A lone load checks them all. By index, decided at
 * module load: a lookup through a `Set` is one a config can replace (D-124).
 */
const EVERY_LOAD: readonly boolean[] = WATCHED_BUILTINS.map(([name]) =>
  [
    'Object.prototype',
    'JSON',
    'Promise.prototype',
    'Map.prototype',
    'Set.prototype',
    'Bun.hash',
  ].includes(name),
)

/** Puts back what changed since `before`, naming each property it put back. */
function restoreBuiltins(before: BuiltinSnapshot | undefined, everyLoadOnly = false): string[] {
  const changed: string[] = []
  if (before === undefined) return changed
  const p = before.prims
  for (let i = 0; i < WATCHED_BUILTINS.length; i++) {
    const name = WATCHED_BUILTINS[i]![0]
    if (everyLoadOnly && !EVERY_LOAD[i]) continue
    const proto = WATCHED_BUILTINS[i]![1]
    const was = before.props[i]
    if (was === undefined) continue
    const keys = p.ownKeys(proto)
    if (unchanged(p, proto, keys, was)) continue
    // Slow path, a change only: a linear lookup keeps it off `Map`.
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!
      let prior: PropertyDescriptor | undefined
      for (let k = 0; k < was.keys.length; k++) {
        if (was.keys[k] === key) {
          prior = was.descriptors[k]
          break
        }
      }
      if (prior === UNREAD) continue
      if (prior !== undefined && sameDescriptor(p, prior, p.descriptorOf(proto, key)!)) continue
      changed[changed.length] = name + '.' + p.keyName(key)
      if (prior === undefined) p.deleteOwn(proto, key)
      else p.defineOwn(proto, key, prior)
    }
    for (let k = 0; k < was.keys.length; k++) {
      const key = was.keys[k]!
      if (p.hasOwn(proto, key)) continue
      changed[changed.length] = name + '.' + p.keyName(key)
      // An unread member cannot be put back as it was; it is refused all the same.
      if (was.descriptors[k] !== UNREAD) p.defineOwn(proto, key, was.descriptors[k]!)
    }
  }
  return changed
}

/**
 * A first load's `process.env.X = …` gave every other project's task that
 * value through `passThrough` and reached vx's own `VX_*` reads, while a
 * repeat load, in a worker, left both unchanged: one config, two
 * environments, by load order (D-76). Assigned back, not defined:
 * `process.env` refuses `defineProperty`.
 */
function restoreEnv(before: Readonly<Record<string, string | undefined>>): string[] {
  const changed: string[] = []
  const live = process.env
  for (const key of Object.keys(live)) {
    if (live[key] === before[key]) continue
    changed.push(`process.env.${key}`)
    if (key in before) live[key] = before[key]
    else delete live[key]
  }
  for (const key of Object.keys(before)) {
    if (!(key in live)) {
      changed.push(`process.env.${key}`)
      live[key] = before[key]
    }
  }
  return changed
}

/**
 * A config's `process.chdir()` moved the whole process: every relative path
 * vx resolves after it, its own and a plugin's, read from the config's
 * choice (D-120). Put back, and named as the change.
 */
function restoreCwd(before: string): string[] {
  const proc = globalThis.process
  if (before === '' || proc.cwd() === before) return []
  proc.chdir(before)
  return ['process.cwd (a chdir)']
}

/**
 * A config's `process.umask()` set the mode of every file vx and its tasks
 * wrote after it: a cache artifact and a task's outputs landed `000`, which
 * a user other than root could not read back (D-125). Put back, and named.
 */
function currentUmask(): number {
  const proc = globalThis.process as { umask?: (mask?: number) => number }
  if (typeof proc.umask !== 'function') return -1
  // Bun reads it by setting 0 and putting it back (probed on 1.4.2: four
  // workers reading at once left the process at 0), so it is read on this
  // thread only, and never while the config worker evaluates.
  return proc.umask()
}

function restoreUmask(before: number): string[] {
  if (before === -1 || currentUmask() === before) return []
  ;(globalThis.process as { umask: (mask: number) => number }).umask(before)
  return ['process.umask']
}

function sameDescriptor(p: Primitives, a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return (
    // `globalThis.NaN` is watched (D-122), and NaN !== NaN.
    p.same(a.value, b.value) &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  )
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const [config] = await loadProjectConfigs([configPath])
  return config!
}

/** When this process first began loading each workspace config, in ms. */
const workspaceLoadedAt = new Map<string, number>()

/**
 * A repeat load in one process (`vx watch`'s every cycle, a plugin verb's
 * every call) busts the workspace config's own URL, but Bun answers what it
 * imports from the module registry: an edited local plugin kept its first
 * version and its old tasks were served with no word (item 1046).
 * Bun cannot evaluate an imported module again, so the load is refused,
 * naming the file, as `vx watch` already says when it sees the edit. Only
 * a repeat load pays for the walk; a CLI verb loads once.
 */
async function refuseStaleWorkspaceImports(configPath: string, since: number): Promise<void> {
  for (const file of await configImports(configPath)) {
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    // `since` is whole milliseconds and an mtime is not: a file written in
    // the millisecond the first load began (1000.4 against 1000) read as
    // changed, and the control reload was refused one run in ten. An edit
    // inside that millisecond is one the load may have read anyway.
    if (Math.floor(mtime) > since) {
      // The walk names real paths: a root reached through a symlink (macOS's
      // temp dir) named `../target/helper.mjs` from the link.
      const real = realpathSync(configPath)
      const root = workspaceRootOf(real)
      throw new UserError(
        `${path.relative(root, real)} imports ${path.relative(root, file)}, which changed after this process loaded it; a running process cannot evaluate an imported module again — restart it to apply the edit`,
      )
    }
  }
}

/**
 * Find and load `.vx/workspace.{ts,mts,js,mjs,cts,cjs}` from the workspace
 * root. Returns `null` if no such file exists (the common case;
 * the schema is fully optional). Validates the shape and throws
 * a `UserError` on malformed input.
 */
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig | null> {
  // The root lookup already probed for it (principle 9): read what it
  // found. A file gone since (a `vx watch` cycle after a rename) is probed for.
  const found = await workspaceFile(path.resolve(root))
  const known =
    found !== null && workspaceRootOf(found) === path.resolve(root)
      ? await Bun.file(found)
          .bytes()
          .then(
            (bytes) => ({ configPath: found, bytes }),
            () => null,
          )
      : null
  const candidates =
    known !== null
      ? [known]
      : found === null
        ? []
        : WORKSPACE_CONFIG_FILENAMES.map((f) => ({ configPath: path.join(root, f), bytes: null }))
  for (const candidate of candidates) {
    const { configPath } = candidate
    const bytes = candidate.bytes ?? (await readOnce(undefined, configPath))
    if (bytes === null) continue
    const since = workspaceLoadedAt.get(configPath)
    if (since !== undefined) await refuseStaleWorkspaceImports(configPath, since)
    const startedAt = Date.now()
    // The same guard a project config's first load has: the workspace config
    // runs in this process too, and its `Object.prototype.exec` ran in a
    // project's task under a key that never saw it (D-126). Its globals are
    // left out: it loads first in every run, filtered or not, so none
    // depends on what else loaded (D-122's case), and plugins' tests and
    // tools hand state through them.
    const unredirect = stdoutToStderr()
    const builtins = builtinSnapshot('globalThis', true)
    const env = { ...process.env }
    const cwd = process.cwd()
    const umask = currentUmask()
    let mod: WorkspaceConfig
    try {
      mod = (await loadDefaultExport(
        configPath,
        'Workspace',
        bytes,
        // Every load, not only the first: a repeat load (the run after the
        // CLI's selection pass) must get the same plugin instances, and a
        // required bundle is the cached module.
        path.resolve(root),
      )) as WorkspaceConfig
    } finally {
      const changed = [
        ...restoreBuiltins(builtins),
        ...restoreEnv(env),
        ...restoreCwd(cwd),
        ...restoreUmask(umask),
      ]
      unredirect()
      // eslint-disable-next-line no-unsafe-finally -- the refusal outranks the load's own error
      if (changed.length > 0) throw builtinsChanged(changed, configPath)
    }
    // Checked again once awaited, as a project config is: a Promise default
    // passed the first check, and `Promise.resolve(null)` crashed the
    // validator with a stack while `Promise.resolve(42)` loaded as no
    // config at all (D-6).
    assertDefaultObject(mod, 'Workspace', configPath)
    validateWorkspace(mod, configPath)
    if (mod.plugins?.some(isSkippedPlugin) === true)
      mod = { ...mod, plugins: mod.plugins.filter((p) => !isSkippedPlugin(p)) }
    // Set by a load that succeeded: a failed one may have left nothing in
    // the registry, and its fix must not be refused.
    if (since === undefined) workspaceLoadedAt.set(configPath, startedAt)
    return mod
  }
  return null
}
