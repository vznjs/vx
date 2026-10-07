// The third `changed file → project` channel for `--affected`.
//
// Directory containment answers "which project owns this file", and
// `cache.inputs.workspaceFiles` answers "which project declared it". Neither
// can see the one remaining way a file reaches a task: a project's
// `vx.config.*` IMPORTS it. Resolved-config hashing folds the imported values
// into the cache key (architecture principle #4), so editing such a file
// re-keys the task — and `affected.ts` states the rule this exists to keep:
// "input hashing sees it, so `--affected` must too."
//
// This is a STATIC scan. Nothing is evaluated: `Bun.Transpiler.scanImports`
// reads the specifiers and `Bun.resolveSync` turns them into paths. The
// `project-loader.ts` note that a bust "cannot reach the config's import
// closure" is about `import()` at runtime, not about reading the source.
//
// Two rules keep the walk small, and the second is the one that makes it
// affordable at all:
//
//   - RELATIVE specifiers only. A bare specifier is a package; it moves when
//     the lockfile moves, which the workspace fingerprint already covers.
//     A tsconfig `paths` / `baseUrl` alias is the exception: Bun loads it
//     from disk (D-27).
//   - Descend only through files owned by NO project, by a ROOT project
//     (whose own files are the shared tooling that is otherwise unowned,
//     D-41), or by the importing file's own project. A config reaching into another project (say a site's
//     `vx.config.ts` importing `../core/src/index.ts`) records that edge
//     and STOPS there — following it would drag substantially all of that
//     project's `src/` into the closure, and the containment channel
//     already selects the project that owns it.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { isOutOfFds } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'

const BUILTINS = new Set(builtinModules)

/**
 * One transpiler per loader, made on first use: constructing one costs
 * 42 µs against 12 µs for the scan itself (measured 2026-09-16), and a
 * fresh one per config put 1000 cold evaluations 130 ms behind.
 */
const transpilers: Partial<Record<'ts' | 'js', Bun.Transpiler>> = {}
function scanner(loader: 'ts' | 'js'): Bun.Transpiler {
  return (transpilers[loader] ??= new Bun.Transpiler({ loader }))
}

/**
 * Whether Bun's own parser finds an ESM `export` in `source` — the one
 * syntax that makes Bun evaluate a file as a module whatever else it says.
 * Without one, a file that touches `module`, `exports`, `require`, `this`
 * or `__dirname` at the top level is CommonJS to Bun. False on source the
 * parser refuses: the evaluation names that error.
 */
export function hasEsmExport(source: string, loader: 'ts' | 'js'): boolean {
  try {
    return scanner(loader).scan(source).exports.length > 0
  } catch {
    return false
  }
}

/** The package a bare specifier names: `@scope/name` or the first segment. */
function packageOf(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

const SPECIFIER =
  /\b(?:from|import)\s*\(?\s*["']([^"'./][^"']*)["']|\brequire\s*\(\s*["']([^"'./][^"']*)["']/g

/** Whether a specifier is one the walk would have to look up at all. */
function needsLookup(spec: string): boolean {
  // `#x` is a package.json `imports` entry: Bun maps it inside the
  // package and never asks the registry, as no npm name opens with `#`
  // (D-28).
  if (spec.startsWith('#') || spec.includes(':') || BUILTINS.has(spec)) return false
  return !(spec === '@vzn/vx' || spec.startsWith('@vzn/vx/'))
}

/**
 * A textual pass before the transpiler's: its scan costs ~50 µs per config
 * in situ (1000 cold evaluations: 50 ms, measured 2026-09-16), and most
 * configs import `@vzn/vx` and nothing else. Every static specifier is a
 * quoted string after `from`, `import` or `require(`; a candidate found
 * here is checked exactly by the scan (a comment or a type-only import is
 * the scan's to drop), and a source with no candidate skips it.
 */
function hasBareCandidate(source: string): boolean {
  SPECIFIER.lastIndex = 0
  for (let m = SPECIFIER.exec(source); m !== null; m = SPECIFIER.exec(source)) {
    if (needsLookup(m[1] ?? m[2] ?? '')) return true
  }
  return false
}

/**
 * The bare specifiers of `source` that no `node_modules/<package>` above
 * `fromDir` provides — the imports Bun would AUTO-INSTALL from the npm
 * registry rather than fail, when no `node_modules` exists anywhere above
 * (measured 2026-09-16: sixteen registry connections and 150 ms before
 * "cannot find"; with one present, 0 and 1 ms). A config is evaluated in
 * the user's process with the user's network: a fresh clone before its
 * install, or a typo, must be a refusal, never a download. Builtins
 * (`node:fs`, `fs`, `bun:sqlite`) and `@vzn/vx` (served by the core alias
 * inside the compiled binary) are never in the list; relative and absolute
 * specifiers resolve by path and are the loader's to refuse.
 */
export function unprovidedBareImports(
  source: string,
  fromDir: string,
  loader: 'ts' | 'js',
): string[] {
  if (!hasBareCandidate(source)) return []
  let specifiers: string[]
  try {
    specifiers = scanner(loader)
      .scanImports(source)
      .map((i) => i.path)
  } catch {
    return [] // unparseable: the evaluation names the syntax error
  }
  const out: string[] = []
  for (const spec of specifiers) {
    if (spec.startsWith('.') || spec.startsWith('/') || !needsLookup(spec)) continue
    const pkg = packageOf(spec)
    let dir = path.resolve(fromDir)
    let provided = false
    for (;;) {
      if (existsSync(path.join(dir, 'node_modules', pkg))) {
        provided = true
        break
      }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
    if (
      !provided &&
      !selfReference(pkg, fromDir) &&
      tsconfigTarget(spec, fromDir) === undefined &&
      !out.includes(spec)
    ) {
      out.push(spec)
    }
  }
  return out
}

interface CompilerPaths {
  paths?: Record<string, unknown>
  /** What `paths` targets resolve against: `baseUrl`, else the config's own dir. */
  pathsBase?: string
  baseUrl?: string
}

/**
 * `compilerOptions.paths` and `baseUrl` after `extends`, each resolved
 * against the config that set it. A package `extends` is not followed: its
 * paths are unseen, so a specifier only they map stays refused.
 */
function compilerPaths(file: string, memo?: TsconfigMemo, depth = 0): CompilerPaths {
  const known = memo?.get(file)
  if (known !== undefined) return known
  let json: unknown
  try {
    json = Bun.JSONC.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof json !== 'object' || json === null) return {}
  const dir = path.dirname(file)
  const out: CompilerPaths = {}
  // A string only: Bun follows no array `extends` (TS 5's form), and an
  // alias only an array maps went to the registry (D-30).
  const ext = (json as { extends?: unknown }).extends
  if (typeof ext === 'string' && ext.startsWith('.') && depth <= 8) {
    const f = path.resolve(dir, ext)
    Object.assign(out, compilerPaths(f.endsWith('.json') ? f : f + '.json', memo, depth + 1))
  }
  const opts = (json as { compilerOptions?: unknown }).compilerOptions
  if (typeof opts !== 'object' || opts === null) return out
  const { baseUrl, paths } = opts as { baseUrl?: unknown; paths?: unknown }
  if (typeof baseUrl === 'string') out.baseUrl = path.resolve(dir, baseUrl)
  if (typeof paths === 'object' && paths !== null) {
    out.paths = paths as Record<string, unknown>
    out.pathsBase = out.baseUrl ?? dir
  } else if (out.paths !== undefined && out.baseUrl !== undefined) {
    out.pathsBase = out.baseUrl
  }
  memo?.set(file, out)
  return out
}

/** The file Bun loads for an extensionless or extensioned path, or undefined. */
function fileAt(target: string): string | undefined {
  for (const f of [
    target,
    ...RESOLVED_EXTENSIONS.map((e) => target + e),
    ...RESOLVED_EXTENSIONS.map((e) => path.join(target, 'index' + e)),
  ]) {
    try {
      if (statSync(f).isFile()) return f
    } catch {}
  }
  return undefined
}

/** Paths per directory and per tsconfig file, memoised across one walk. */
type TsconfigMemo = Map<string, CompilerPaths>

/**
 * The paths of the nearest `tsconfig.json`, else `jsconfig.json`, at or
 * above `dir`: Bun reads that one alone.
 */
function pathsAt(dir: string, memo?: TsconfigMemo): CompilerPaths {
  const known = memo?.get(dir)
  if (known !== undefined) return known
  const file = ['tsconfig.json', 'jsconfig.json'].map((n) => path.join(dir, n)).find(existsSync)
  const up = path.dirname(dir)
  const cp = file !== undefined ? compilerPaths(file, memo) : up === dir ? {} : pathsAt(up, memo)
  memo?.set(dir, cp)
  return cp
}

/**
 * Whether `source` quotes a bare specifier the nearest tsconfig maps: the
 * textual pass that keeps a config importing only packages unscanned, as
 * D-23's keeps one importing nothing relative (D-27).
 */
function hasAliasCandidate(source: string, fromDir: string, memo: TsconfigMemo): boolean {
  SPECIFIER.lastIndex = 0
  for (let m = SPECIFIER.exec(source); m !== null; m = SPECIFIER.exec(source)) {
    const spec = m[1] ?? m[2] ?? ''
    if (needsLookup(spec) && tsconfigBases(spec, fromDir, memo).length > 0) return true
  }
  return false
}

/**
 * The paths a bare specifier names through the nearest tsconfig's `paths`
 * (each matching target, in order) or `baseUrl`, before extensions: Bun
 * tries them ahead of `node_modules`.
 */
function tsconfigBases(spec: string, fromDir: string, memo?: TsconfigMemo): string[] {
  const { paths, pathsBase, baseUrl } = pathsAt(path.resolve(fromDir), memo)
  const out: string[] = []
  for (const [key, targets] of Object.entries(paths ?? {})) {
    const star = key.indexOf('*')
    let hole: string
    if (star === -1) {
      if (spec !== key) continue
      hole = ''
    } else {
      const head = key.slice(0, star)
      const tail = key.slice(star + 1)
      if (spec.length < key.length - 1 || !spec.startsWith(head) || !spec.endsWith(tail)) continue
      hole = spec.slice(head.length, spec.length - tail.length)
    }
    for (const t of Array.isArray(targets) ? targets : []) {
      if (typeof t === 'string') out.push(path.resolve(pathsBase!, t.replace('*', hole)))
    }
  }
  if (baseUrl !== undefined) out.push(path.resolve(baseUrl, spec))
  return out
}

/**
 * The local file a bare specifier names through the nearest tsconfig, as
 * Bun resolves it (D-26): an alias whose target exists loads from disk and
 * never reaches the registry.
 */
function tsconfigTarget(spec: string, fromDir: string, memo?: TsconfigMemo): string | undefined {
  for (const base of tsconfigBases(spec, fromDir, memo)) {
    const hit = fileAt(base)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** A path as Bun names it: realpath'd when it exists. */
function realpathOr(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** A path and, bare of an extension, the files Bun would try for it. */
function expansions(named: string): string[] {
  if (path.extname(named) !== '') return [named]
  return [named, ...RESOLVED_EXTENSIONS.flatMap((e) => [named + e, path.join(named, 'index' + e)])]
}

/**
 * Whether `pkg` names the package `fromDir` sits in, and that package has
 * `exports`: Bun resolves such a self-reference inside it and never asks
 * the registry, an unexported subpath included (strace, D-29).
 */
function selfReference(pkg: string, fromDir: string): boolean {
  for (let dir = path.resolve(fromDir); ;) {
    const manifest = path.join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown
          exports?: unknown
        }
        return json.name === pkg && json.exports !== undefined
      } catch {
        return false
      }
    }
    const up = path.dirname(dir)
    if (up === dir) return false
    dir = up
  }
}

/**
 * A textual pass before the scan: a relative specifier opens with a quoted
 * `./` or `../`, or spells one with an escape, and most configs hold
 * neither, so the scan is skipped for them (D-23). A candidate in a comment
 * or string still goes to the scan, which decides.
 */
const RELATIVE_CANDIDATE = /["'`](?:\.\.?\/|[^"'`\n]*\\)/

/**
 * Absolute resolved targets of the RELATIVE specifiers in `source`; one that
 * does not resolve contributes the paths it names.
 *
 * Paths come back realpath'd, because `Bun.resolveSync` realpaths them — see
 * the caller, which realpaths everything it compares against for exactly that
 * reason. `import type` is erased by `scanImports` and so contributes no edge,
 * which is correct: an erased import cannot move a resolved value.
 */
function scanLocalImports(
  source: string,
  fromDir: string,
  loader: 'ts' | 'js',
  memo: TsconfigMemo,
): string[] {
  const aliased = hasAliasCandidate(source, fromDir, memo)
  if (!aliased && !RELATIVE_CANDIDATE.test(source)) return []
  let specifiers: string[]
  try {
    specifiers = scanner(loader)
      .scanImports(source)
      .map((i) => i.path)
  } catch {
    return [] // unparseable source contributes no edges
  }
  const out: string[] = []
  for (const spec of specifiers) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      // A tsconfig alias is a local import Bun resolves by path (D-27); a
      // target the change deleted still names its paths, as below.
      if (!aliased || spec.startsWith('.') || spec.startsWith('/') || !needsLookup(spec)) continue
      const bases = tsconfigBases(spec, fromDir, memo)
      const hit = bases.map(fileAt).find((f) => f !== undefined)
      if (hit !== undefined) out.push(realpathOr(hit))
      else out.push(...bases.flatMap(expansions))
      continue
    }
    try {
      out.push(Bun.resolveSync(spec, fromDir))
    } catch {
      // Unresolvable: most often the change itself deleted or renamed the
      // target, and the config that imports it is exactly the project the
      // change broke. The edge is the path the specifier names (and, bare
      // of an extension, the files Bun would have tried), so the deleted
      // path in the diff still reaches its importer (item 958). Selection
      // may widen; it is never hashed.
      out.push(...expansions(path.resolve(fromDir, spec)))
    }
  }
  return out
}

export interface ConfigImportOwnersArgs {
  /**
   * Realpath'd HERE, not by the caller. `Bun.resolveSync` returns realpath'd
   * targets, so a raw root silently fails every containment check and the
   * scan reports "no imports" — indistinguishable from a clean tree. Owning
   * the normalisation in one place makes that misuse unrepresentable.
   */
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  /** Workspace-relative POSIX paths — the same list containment consumed. */
  changed: readonly string[]
  /** Already-selected projects; their configs need no scan. */
  skip: ReadonlySet<string>
  /**
   * Each project dir's realpath, when the caller already has them: the
   * containment pass needs the same answers, and asking twice cost 5,000
   * realpaths at 5,000 projects (D-24).
   */
  realDirs?: ReadonlyMap<string, string>
}

/**
 * Project dir → name, REALPATH'D — which is why this cannot reuse the index
 * the containment pass builds. `Bun.resolveSync` hands back realpath'd
 * targets, and on darwin a workspace under `os.tmpdir()` lives at
 * `/var/folders/…` while its realpath is `/private/var/folders/…`; comparing
 * the two matches nothing and fails exactly like "found no imports".
 */
async function realDirIndex(
  projects: readonly ProjectMeta[],
  known: ReadonlyMap<string, string> | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    projects.map(async (p) => {
      out.set(known?.get(p.dir) ?? (await realpath(p.dir).catch(() => p.dir)), p.name)
    }),
  )
  return out
}

const TS_EXT = new Set(['.ts', '.mts', '.cts'])

/** The extensions Bun tries for a specifier that names none. */
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']

/** The deepest project containing `file`, or undefined when none does. */
function ownerOf(file: string, dirToName: ReadonlyMap<string, string>): string | undefined {
  let dir = path.dirname(file)
  for (;;) {
    const name = dirToName.get(dir)
    if (name !== undefined) return name
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Projects whose config file transitively imports one of `changed`. */
export async function configImportOwners(a: ConfigImportOwnersArgs): Promise<Set<string>> {
  const selected = new Set<string>()
  if (a.changed.length === 0 || a.skip.size === a.projects.length) return selected
  const workspaceRoot = await realpath(a.workspaceRoot).catch(() => a.workspaceRoot)

  const roots = new Map<string, string>() // abs config path → project name
  await Promise.all(
    a.projects.map(async (p) => {
      const cfg = p.configPath
      if (cfg === null || cfg === '' || a.skip.has(p.name)) return
      roots.set(await realpath(cfg).catch(() => path.resolve(cfg)), p.name)
    }),
  )
  if (roots.size === 0) return selected
  const dirToName = await realDirIndex(a.projects, a.realDirs)
  // A root project owns every file no member owns: the shared tooling the
  // walk descends through when the root is no project (D-41).
  const rootOwner = dirToName.get(workspaceRoot)

  // target → the files that import it. Reversed up front so one BFS from the
  // changed set answers every root at once, instead of a walk per root.
  const tsconfigs: TsconfigMemo = new Map()
  const importedBy = new Map<string, string[]>()
  const visited = new Set<string>()
  // A level at a time, its files read together: one awaited read per
  // config put 5,000 of them 200 ms behind (D-23).
  let frontier = [...roots.keys()]
  while (frontier.length > 0) {
    const read = await Promise.all(
      frontier.map(async (file) => {
        if (visited.has(file)) return null
        visited.add(file)
        try {
          return { file, source: await Bun.file(file).text() }
        } catch (err) {
          // Out of descriptors is this level's width, not the file: read as
          // no edges, it dropped every project the import selects (D-63).
          if (isOutOfFds(err)) throw err
          return null // unreadable: no edges, and not this pass's problem to report
        }
      }),
    )
    frontier = []
    for (const entry of read) {
      if (entry === null) continue
      const { file, source } = entry
      const loader = TS_EXT.has(path.extname(file)) ? 'ts' : 'js'
      const from = ownerOf(file, dirToName)
      for (const target of scanLocalImports(source, path.dirname(file), loader, tsconfigs)) {
        if (!target.startsWith(workspaceRoot + path.sep)) continue
        if (target.split(path.sep).includes('node_modules')) continue
        const list = importedBy.get(target)
        if (list) list.push(file)
        else importedBy.set(target, [file])
        // Descend ONLY through unowned files, the root project's own, or
        // the importer's own project's (a config split into `./tasks.mjs`
        // that imports shared tooling): see the header.
        const owner = ownerOf(target, dirToName)
        if (owner === undefined || owner === rootOwner || owner === from) frontier.push(target)
      }
    }
  }

  const seen = new Set<string>()
  const walk = [...a.changed.map((rel) => path.resolve(workspaceRoot, rel))]
  while (walk.length > 0) {
    const file = walk.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const owner = roots.get(file)
    if (owner !== undefined) selected.add(owner)
    for (const importer of importedBy.get(file) ?? []) walk.push(importer)
  }
  return selected
}
