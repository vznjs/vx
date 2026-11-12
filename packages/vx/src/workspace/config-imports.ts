// The third changed-file-to-project channel for `--affected`. Containment says
// which project owns a file, `inputs.workspaceFiles` which declared it; neither
// sees a project's `vx.config.*` importing it. Resolved-config hashing folds
// imported values into the key, so editing such a file re-keys the task, and
// selection must follow.
//
// A static scan: `Bun.Transpiler.scanImports` reads specifiers,
// `Bun.resolveSync` makes paths. Nothing is evaluated.
//
// - Local specifiers only (`localTarget`): relative, `#imports`, or a tsconfig
//   `paths`/`baseUrl` alias. Other bare specifiers are packages, covered by a
//   lockfile plugin's key.
// - One reversed BFS from every config at once, each file read once. It
//   descends into other projects' files too: a site config importing
//   `../core/src/index.ts` evaluates what that imports, so an edit there moves
//   the site's key.
//
// `configImports` walks one config's closure forward, by the same rule, for `vx
// watch`.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { isOutOfFds, realPath } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'

const BUILTINS = new Set(builtinModules)

/**
 * One transpiler per loader, made on first use: constructing one costs 42 µs
 * against the scan's 12, and one per config put 1,000 cold evaluations 130 ms
 * behind.
 */
const transpilers: Partial<Record<'ts' | 'js', Bun.Transpiler>> = {}
function scanner(loader: 'ts' | 'js'): Bun.Transpiler {
  return (transpilers[loader] ??= new Bun.Transpiler({ loader }))
}

/**
 * Whether Bun's parser finds an ESM `export` in `source`, the one syntax that
 * makes Bun evaluate a module regardless. Without it, top-level `module`,
 * `exports`, `require`, `this` or `__dirname` make it CommonJS. False on
 * unparseable source: evaluation names that error.
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
  // `#x` is a package.json `imports` entry: Bun maps it inside the package and
  // never asks the registry, as no npm name opens with `#`.
  if (spec.startsWith('#') || spec.includes(':') || BUILTINS.has(spec)) return false
  return !(spec === '@vzn/vx' || spec.startsWith('@vzn/vx/'))
}

/**
 * A textual pass before the transpiler's ~50 µs scan: most configs import only
 * `@vzn/vx`. Every static specifier is a quoted string after `from`, `import`
 * or `require(`; candidates go to the scan, which decides, and a source with
 * none skips it.
 */
function hasBareCandidate(source: string): boolean {
  SPECIFIER.lastIndex = 0
  for (let m = SPECIFIER.exec(source); m !== null; m = SPECIFIER.exec(source)) {
    if (needsLookup(m[1] ?? m[2] ?? '')) return true
  }
  return false
}

/**
 * The bare specifiers no `node_modules/<package>` above `fromDir` provides:
 * imports Bun would auto-install from the registry when no `node_modules`
 * exists above (16 registry connections, 150 ms). A config evaluates with the
 * user's network, so a fresh clone or a typo must be a refusal, never a
 * download. Builtins and `@vzn/vx` (the core alias) are never listed; path
 * specifiers are the loader's to refuse.
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
 * `compilerOptions.paths` and `baseUrl` after `extends`, each against the
 * config that set it. A package `extends` is not followed: specifiers only it
 * maps stay refused.
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
  // A string only: Bun follows no array `extends` (TS 5's form), and an alias
  // only an array maps went to the registry.
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
 * textual pass that keeps a packages-only config unscanned.
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
 * The paths a bare specifier names through the nearest tsconfig's `paths` (each
 * matching target, in order) or `baseUrl`, before extensions: Bun tries them
 * before `node_modules`.
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
 * The local file a bare specifier names through the nearest tsconfig, as Bun
 * resolves it: an existing alias target never reaches the registry.
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
 * Whether `pkg` is the package `fromDir` sits in and has `exports`: Bun
 * resolves such a self-reference locally, unexported subpaths included.
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
 * `imports` (exact key, else the longest-head `*` pattern, as Node picks), and
 * whether all are local. An entry mapping to a package is the lockfile's.
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
 * The local file `spec` names from `fromDir`, by Bun's rules: a relative path,
 * a `#imports` entry, or a tsconfig alias. `file` is the realpath'd hit. With
 * none, `named` lists the paths it names (and, without an extension, the files
 * Bun would try): usually the change deleted or renamed the target, and its
 * importer is the project it broke. Undefined for packages, builtins and
 * `@vzn/vx`.
 *
 * Both walks ask this, so `--affected` and `vx watch` cannot part.
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
    // Bun picks the condition; asked only when no condition names a package,
    // which it would fetch with no node_modules above.
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
 * A textual pass before the scan: a local specifier opens with a quoted `./`,
 * `../`, `.`, `..` or `#` (or an escape), and most configs hold none.
 * Candidates go to the scan.
 */
const LOCAL_CANDIDATE = /["'`](?:\.\.?(?:\/|["'`])|#|[^"'`\n]*\\)/

/**
 * Absolute, realpath'd targets of the local specifiers in `source` ({@link
 * localTarget}); the caller realpaths what it compares against. `import type`
 * is erased by `scanImports`, correctly: it cannot move a value.
 */
function scanLocalImports(
  source: string,
  fromDir: string,
  loader: 'ts' | 'js',
  memo: LookupMemo,
  /** Also follow a bare specifier into a package linked from outside `node_modules` ({@link linkedPackageFile}). */
  linked = false,
): string[] {
  if (
    !LOCAL_CANDIDATE.test(source) &&
    !hasAliasCandidate(source, fromDir, memo.tsconfig) &&
    !(linked && hasBareCandidate(source))
  )
    return []
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
    if (t === undefined) {
      const file = linked ? linkedPackageFile(spec, fromDir) : undefined
      if (file !== undefined) out.push(file)
    } else if ('file' in t) out.push(t.file)
    else out.push(...t.named)
  }
  return out
}

/**
 * The file a bare `spec` loads when the nearest `node_modules/<package>` links
 * outside any `node_modules`: a workspace package, whose source the lockfile
 * does not pin. Undefined for an installed package or none (resolving could hit
 * the registry).
 */
function linkedPackageFile(spec: string, fromDir: string): string | undefined {
  if (spec.startsWith('.') || spec.startsWith('/') || !needsLookup(spec)) return undefined
  const pkg = packageOf(spec)
  for (let dir = fromDir; ;) {
    const installed = path.join(dir, 'node_modules', pkg)
    if (existsSync(installed)) {
      if (realpathOr(installed).split(path.sep).includes('node_modules')) return undefined
      try {
        return realpathOr(Bun.resolveSync(spec, fromDir))
      } catch {
        return undefined
      }
    }
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

export interface ConfigImportOwnersArgs {
  /**
   * Realpath'd here, not by the caller: `Bun.resolveSync` returns realpaths, so
   * a raw root failed every containment check and the scan reported no imports,
   * indistinguishable from a clean tree.
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
  /**
   * The files a workspace config imports above the workspace root,
   * realpath'd: `changed` cannot name them, so the caller asks git.
   */
  outside?: string[]
}

const TS_EXT = new Set(['.ts', '.mts', '.cts'])

/** The extensions Bun tries for a specifier that names none. */
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']

/** Projects whose config file transitively imports one of `changed`. */
export async function configImportOwners(a: ConfigImportOwnersArgs): Promise<ConfigImportOwners> {
  const selected = new Set<string>()
  const wsConfigs = a.workspaceConfigs ?? []
  if (a.changed.length === 0 && wsConfigs.length === 0) return { owners: selected }
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
  // The workspace config loads live, not from the lock, so its walk goes
  // further: into workspace packages it names, and above the root.
  const outside = new Set<string>()
  const walkImports = async (start: string[], ws: boolean): Promise<void> => {
    // A level at a time, its files read together: one awaited read per config
    // put 5,000 of them 200 ms behind.
    let frontier = start
    while (frontier.length > 0) {
      const read = await Promise.all(
        frontier.map(async (file) => {
          if (visited.has(file)) return null
          visited.add(file)
          try {
            return { file, source: await Bun.file(file).text() }
          } catch (err) {
            // Out of descriptors is this level's width, not the file: read as
            // no edges, it dropped every project the import selects.
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
        for (const target of scanLocalImports(source, path.dirname(file), loader, memo, ws)) {
          if (target.split(path.sep).includes('node_modules')) continue
          if (!target.startsWith(workspaceRoot + path.sep)) {
            if (!ws) continue
            outside.add(target)
          }
          const list = importedBy.get(target)
          if (list) list.push(file)
          else importedBy.set(target, [file])
          frontier.push(target)
        }
      }
    }
  }
  await walkImports([...wsRoots], true)
  await walkImports([...roots.keys()], false)

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
  if (workspace !== undefined) return { owners: selected, workspace }
  return outside.size === 0 ? { owners: selected } : { owners: selected, outside: [...outside] }
}

/**
 * The canonical directory Bun resolves `file`'s imports from: its real path's,
 * so a linked-in config imports its real neighbours.
 */
function realDirOf(file: string): string {
  if (lstatSync(file).isSymbolicLink()) return path.dirname(realPath(file))
  return realPath(path.dirname(file))
}

/**
 * Every file a config imports by local specifier, transitively, outside
 * `node_modules`, the config excluded: what `vx watch` watches (a shared preset
 * outside the project changed a run and no watcher saw it). An unreadable file
 * ends its branch; an unresolvable import is listed by the names it would have.
 * `configSource` is the config's if already read; `read` reads the rest.
 * `statics` gets the files reached by static imports alone.
 */
export async function configImports(
  configPath: string,
  configSource?: string,
  read: (file: string) => Promise<string> = (file) => Bun.file(file).text(),
  statics?: Set<string>,
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
    let specs: Array<{ path: string; kind: string }>
    try {
      specs = scanner(TS_EXT.has(path.extname(file)) ? 'ts' : 'js').scanImports(source)
    } catch {
      // A source the parser refuses (mid-edit) keeps the imports a plain match
      // sees: watching too few files is the failure this prevents.
      specs = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)].map(
        (m) => ({ path: (m[1] ?? m[2])!, kind: 'import-statement' }),
      )
    }
    const fromStatic = statics !== undefined && (file === configPath || statics.has(file))
    let dir: string | undefined
    for (const { path: spec, kind } of specs) {
      let t: ReturnType<typeof localTarget>
      try {
        dir ??= realDirOf(file)
        t = localTarget(spec, dir, memo)
      } catch {
        continue
      }
      if (t === undefined) continue
      if (!('file' in t)) {
        // Missing for now, still imported: its config fails until it is back,
        // and leaving it out made `vx watch` deaf to its return. Named as
        // written, not walked.
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
      if (fromStatic && kind === 'import-statement') statics.add(resolved)
    }
  }
  return out
}
