// The third `changed file → project` channel for `--affected`.
//
// Directory containment answers "which project owns this file", and
// `inputs.workspaceFiles` answers "which project declared it". Neither
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
//   - LOCAL specifiers only (`localTarget`): relative, package.json
//     `#imports`, or a tsconfig `paths` / `baseUrl` alias, each of which
//     Bun loads from disk (D-27). Any other bare specifier is a package; it
//     moves when the lockfile moves, which a lockfile plugin's key covers.
//   - One reversed BFS from every config at once, each file read once
//     however many configs reach it. It descends through every file in
//     the workspace, another project's included: a site's `vx.config.ts`
//     importing `../core/src/index.ts` evaluates what that file imports
//     too, so an edit there moves the site's key. The walk stopped at the
//     first file of another project, and containment selected core alone
//     while the site's key moved (X-128).
//
// `configImports` walks one config's local closure forward, by the same
// rule, for the files `vx watch` watches.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { isOutOfFds, realPath } from '../util/index.js'
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
export function realpathOr(file: string): string {
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
        const json = JSON.parse(readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '')) as {
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

/** The nearest `package.json`'s directory and `imports` map, per directory. */
type ImportsMemo = Map<string, { dir: string; imports: Record<string, unknown> } | null>

/** What one walk learns once: tsconfig paths and package `imports` per directory. */
interface LookupMemo {
  tsconfig: TsconfigMemo
  imports: ImportsMemo
}

function lookupMemo(): LookupMemo {
  return { tsconfig: new Map(), imports: new Map() }
}

/** The `imports` map of the package `dir` sits in: its nearest `package.json`'s. */
function importsAt(
  dir: string,
  memo: ImportsMemo,
): { dir: string; imports: Record<string, unknown> } | null {
  const known = memo.get(dir)
  if (known !== undefined) return known
  let out: { dir: string; imports: Record<string, unknown> } | null = null
  const manifest = path.join(dir, 'package.json')
  const up = path.dirname(dir)
  if (existsSync(manifest)) {
    try {
      const json = JSON.parse(readFileSync(manifest, 'utf8').replace(/^﻿/, '')) as {
        imports?: unknown
      }
      if (typeof json.imports === 'object' && json.imports !== null) {
        out = { dir, imports: json.imports as Record<string, unknown> }
      }
    } catch {}
  } else if (up !== dir) {
    out = importsAt(up, memo)
  }
  memo.set(dir, out)
  return out
}

/** Every string a package `imports` target holds, through arrays and conditions. */
function targetStrings(target: unknown): string[] {
  if (typeof target === 'string') return [target]
  if (Array.isArray(target)) return target.flatMap(targetStrings)
  if (typeof target === 'object' && target !== null)
    return Object.values(target).flatMap(targetStrings)
  return []
}

/**
 * The paths a `#` specifier's entry names in the nearest `package.json`
 * `imports` (exact key, else the `*` pattern with the longest head, as
 * Node picks), and whether every target is local. An entry mapping to a
 * package is the lockfile's, as any bare specifier.
 */
function packageImportPaths(
  spec: string,
  fromDir: string,
  memo: ImportsMemo,
): { paths: string[]; allLocal: boolean } | undefined {
  const scope = importsAt(fromDir, memo)
  if (scope === null) return undefined
  let target: unknown = scope.imports[spec]
  let hole = ''
  if (target === undefined) {
    let head = ''
    for (const [key, t] of Object.entries(scope.imports)) {
      const star = key.indexOf('*')
      if (star === -1 || star < head.length) continue
      const h = key.slice(0, star)
      const tail = key.slice(star + 1)
      if (spec.length < key.length - 1 || !spec.startsWith(h) || !spec.endsWith(tail)) continue
      head = h
      target = t
      hole = spec.slice(h.length, spec.length - tail.length)
    }
  }
  const strings = targetStrings(target)
  const local = strings.filter((s) => s.startsWith('./'))
  if (local.length === 0) return undefined
  return {
    paths: local.map((s) => path.resolve(scope.dir, s.replaceAll('*', hole))),
    allLocal: local.length === strings.length,
  }
}

/**
 * The local file `spec` names from `fromDir`, by the rules Bun loads one
 * with: a relative path (`.`, `..`, `./x`, `../x`), a package.json
 * `#imports` entry, or a tsconfig `paths` / `baseUrl` alias (D-27).
 * `file` is the hit, realpath'd as `Bun.resolveSync` names one. With none, `named` lists the paths the
 * specifier names (and, bare of an extension, the files Bun would have
 * tried): most often the change itself deleted or renamed the target, and
 * the config importing it is the project the change broke (item 958).
 * Undefined for a package, a builtin or `@vzn/vx`.
 *
 * Both walks ask this, so what `--affected` follows and what `vx watch`
 * watches cannot part: the watch walk once kept `./` and `../` alone.
 */
function localTarget(
  spec: string,
  fromDir: string,
  memo: LookupMemo,
): { file: string } | { named: string[] } | undefined {
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    try {
      return { file: Bun.resolveSync(spec, fromDir) }
    } catch {
      return { named: expansions(path.resolve(fromDir, spec)) }
    }
  }
  if (spec.startsWith('#')) {
    const entry = packageImportPaths(spec, fromDir, memo.imports)
    if (entry === undefined) return undefined
    // Bun picks the condition; it is asked only when no condition names a
    // package, which it would fetch from the registry with no
    // node_modules above.
    if (entry.allLocal) {
      try {
        return { file: Bun.resolveSync(spec, fromDir) }
      } catch {}
    }
    return { named: entry.paths.flatMap(expansions) }
  }
  if (spec.startsWith('.') || spec.startsWith('/') || !needsLookup(spec)) return undefined
  const bases = tsconfigBases(spec, fromDir, memo.tsconfig)
  if (bases.length === 0) return undefined
  const hit = bases.map(fileAt).find((f) => f !== undefined)
  return hit !== undefined ? { file: realpathOr(hit) } : { named: bases.flatMap(expansions) }
}

/**
 * A textual pass before the scan: a local specifier opens with a quoted
 * `./`, `../`, `.`, `..` or `#`, or spells one with an escape, and most
 * configs hold none, so the scan is skipped for them (D-23). A candidate in
 * a comment or string still goes to the scan, which decides.
 */
const LOCAL_CANDIDATE = /["'`](?:\.\.?(?:\/|["'`])|#|[^"'`\n]*\\)/

/**
 * Absolute targets of the local specifiers in `source` ({@link localTarget}).
 *
 * Paths come back realpath'd, as `Bun.resolveSync` names them — see the
 * caller, which realpaths everything it compares against for exactly that
 * reason. `import type` is erased by `scanImports` and so contributes no edge,
 * which is correct: an erased import cannot move a resolved value.
 */
function scanLocalImports(
  source: string,
  fromDir: string,
  loader: 'ts' | 'js',
  memo: LookupMemo,
): string[] {
  if (!LOCAL_CANDIDATE.test(source) && !hasAliasCandidate(source, fromDir, memo.tsconfig)) return []
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
    // Selection may widen on a named path; it is never hashed.
    const t = localTarget(spec, fromDir, memo)
    if (t === undefined) continue
    if ('file' in t) out.push(t.file)
    else out.push(...t.named)
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
  /** The workspace config files: one of `changed` they import is {@link ConfigImportOwners.workspace}. */
  workspaceConfigs?: readonly string[]
}

export interface ConfigImportOwners {
  owners: Set<string>
  /** A changed file a workspace config imports, which can re-key any task. */
  workspace?: string
}

const TS_EXT = new Set(['.ts', '.mts', '.cts'])

/** The extensions Bun tries for a specifier that names none. */
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']

/** Projects whose config file transitively imports one of `changed`. */
export async function configImportOwners(a: ConfigImportOwnersArgs): Promise<ConfigImportOwners> {
  const selected = new Set<string>()
  const wsConfigs = a.workspaceConfigs ?? []
  if (a.changed.length === 0) return { owners: selected }
  if (a.skip.size === a.projects.length && wsConfigs.length === 0) return { owners: selected }
  const workspaceRoot = await realpath(a.workspaceRoot).catch(() => a.workspaceRoot)

  const roots = new Map<string, string>() // abs config path → project name
  await Promise.all(
    a.projects.map(async (p) => {
      const cfg = p.configPath
      if (cfg === null || cfg === '' || a.skip.has(p.name)) return
      roots.set(await realpath(cfg).catch(() => path.resolve(cfg)), p.name)
    }),
  )
  const wsRoots = new Set(
    await Promise.all(wsConfigs.map((f) => realpath(f).catch(() => path.resolve(f)))),
  )
  if (roots.size === 0 && wsRoots.size === 0) return { owners: selected }

  // target → the files that import it. Reversed up front so one BFS from the
  // changed set answers every root at once, instead of a walk per root.
  const memo = lookupMemo()
  const importedBy = new Map<string, string[]>()
  const visited = new Set<string>()
  // A level at a time, its files read together: one awaited read per
  // config put 5,000 of them 200 ms behind (D-23).
  let frontier = [...roots.keys(), ...wsRoots]
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
      for (const target of scanLocalImports(source, path.dirname(file), loader, memo)) {
        if (!target.startsWith(workspaceRoot + path.sep)) continue
        if (target.split(path.sep).includes('node_modules')) continue
        const list = importedBy.get(target)
        if (list) list.push(file)
        else importedBy.set(target, [file])
        frontier.push(target)
      }
    }
  }

  let workspace: string | undefined
  const seen = new Set<string>()
  // Each entry carries the changed file it came from, to name the one that
  // reaches a workspace config.
  const walk = a.changed.map((rel) => [path.resolve(workspaceRoot, rel), rel] as const)
  while (walk.length > 0) {
    const [file, from] = walk.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const owner = roots.get(file)
    if (owner !== undefined) selected.add(owner)
    if (wsRoots.has(file)) workspace ??= from
    for (const importer of importedBy.get(file) ?? []) walk.push([importer, from])
  }
  return workspace === undefined ? { owners: selected } : { owners: selected, workspace }
}

/**
 * The canonical directory Bun resolves `file`'s imports from: its REAL
 * path's, so a config linked in from elsewhere imports its neighbours
 * there, not beside the link (item 950).
 */
function realDirOf(file: string): string {
  if (lstatSync(file).isSymbolicLink()) return path.dirname(realPath(file))
  return realPath(path.dirname(file))
}

/**
 * Every file a config imports by local specifier, transitively, outside
 * `node_modules`, the config itself excluded. `vx watch` watches these: a
 * shared preset outside the project (`../../shared/preset.mjs`, the way
 * configs compose) changed what a run evaluates and no watcher saw it
 * (item 949). A file that cannot be read ends its branch; an import that
 * cannot be resolved is still listed, by the names it would have.
 * `configSource` is the config's, when the caller has read it; `read` reads the
 * rest, for a caller that keeps what was read.
 */
export async function configImports(
  configPath: string,
  configSource?: string,
  read: (file: string) => Promise<string> = (file) => Bun.file(file).text(),
): Promise<string[]> {
  const seen = new Set<string>([configPath])
  const memo = lookupMemo()
  const out: string[] = []
  const queue = [configPath]
  let given = configSource
  while (queue.length > 0) {
    const file = queue.shift()!
    let source: string
    try {
      source = given ?? (await read(file))
    } catch {
      continue
    } finally {
      given = undefined
    }
    let specs: string[]
    try {
      specs = scanner(TS_EXT.has(path.extname(file)) ? 'ts' : 'js')
        .scanImports(source)
        .map((i) => i.path)
    } catch {
      // A source the parser refuses (mid-edit) keeps the imports a plain
      // match sees: watching too few files is what this list exists to
      // prevent.
      specs = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)].map(
        (m) => (m[1] ?? m[2])!,
      )
    }
    let dir: string | undefined
    for (const spec of specs) {
      let t: ReturnType<typeof localTarget>
      try {
        dir ??= realDirOf(file)
        t = localTarget(spec, dir, memo)
      } catch {
        continue
      }
      if (t === undefined) continue
      if (!('file' in t)) {
        // Missing for now, still imported: the config that names it fails
        // to load until it is back, and a list without it left `vx watch`
        // deaf to its return. Named as written, and not walked.
        for (const missing of t.named) {
          if (seen.has(missing)) continue
          seen.add(missing)
          out.push(missing)
        }
        continue
      }
      const resolved = realpathOr(t.file)
      if (seen.has(resolved) || resolved.split(path.sep).includes('node_modules')) continue
      seen.add(resolved)
      out.push(resolved)
      queue.push(resolved)
    }
  }
  return out
}
