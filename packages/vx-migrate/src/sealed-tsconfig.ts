// A tsconfig that is a composite project (or sets `rootDir`) refuses a
// source file outside its directory: withastro/astro's
// `scripts/tsconfig.json` type-checked the written `vx.config.mjs`, and its
// import of the root `vx-preset.mjs` failed the build (TS6059, TS6307). So
// did `packages/astro/tsconfig.test.json`, which takes in the nested
// `performance/vx.config.mjs`. An emitting project (`outDir`) takes the
// preset in and computes its root above it, so its output moved: cal.com's
// `"include": ["."]` put `dist/index.js` at
// `dist/packages/platform/constants/index.js`. A config such a project takes
// in declares the preset values it uses itself.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

type TsConfig = {
  extends?: unknown
  include?: unknown
  exclude?: unknown
  files?: unknown
  compilerOptions?: { composite?: unknown; rootDir?: unknown; outDir?: unknown; noEmit?: unknown }
}

function read(file: string): TsConfig | null {
  try {
    return (Bun.JSONC.parse(readFileSync(file, 'utf8')) ?? {}) as TsConfig
  } catch {
    return null
  }
}

/** A tsconfig glob as `Bun.Glob` reads it, relative to the tsconfig's own directory. */
function pattern(p: string): string {
  const rel = p.replace(/^\$\{configDir\}\/?/, '').replace(/^\.\//, '')
  if (rel === '' || rel === '.') return '**/*'
  // A directory names everything under it, as tsc reads it.
  return /[*?{]/.test(rel) || /\.[A-Za-z0-9]+$/.test(rel) ? rel : `${rel.replace(/\/$/, '')}/**/*`
}

/**
 * Does the project `file` states take in `rel` (relative to its directory)
 * and refuse files outside it, or emit with them?
 */
function seals(file: string, rel: string): boolean {
  let sealed: boolean | undefined
  let outDir: unknown
  let noEmit: unknown
  let include: unknown
  let exclude: unknown
  let files: unknown
  // The nearest file that states a field decides it, as `extends` resolves:
  // the file, then its bases, a later entry of an `extends` list first.
  for (const at of chain(file)) {
    const o = at.compilerOptions
    if (sealed === undefined && o?.composite !== undefined) sealed = o.composite === true
    if (sealed !== true && typeof o?.rootDir === 'string') sealed = true
    outDir ??= o?.outDir
    noEmit ??= o?.noEmit
    include ??= at.include
    exclude ??= at.exclude
    files ??= at.files
  }
  if (sealed !== true && (typeof outDir !== 'string' || noEmit === true)) return false
  const hit = (list: unknown): boolean =>
    Array.isArray(list) &&
    list.some((g) => typeof g === 'string' && new Bun.Glob(pattern(g)).match(rel))
  if (hit(exclude)) return false
  if (Array.isArray(files) && files.some((f) => typeof f === 'string' && pattern(f) === rel))
    return true
  if (Array.isArray(include)) return hit(include)
  // `files` alone lists exactly what it compiles; neither means everything.
  return !Array.isArray(files)
}

/**
 * `file` and the configs it extends, in the order they decide a field.
 * A package base is followed too: trpc's monotest packages extend
 * `@monotest/tsconfig/base.json`, whose `rootDir` refused the preset.
 */
function chain(file: string): TsConfig[] {
  const out: TsConfig[] = []
  const seen = new Set<string>()
  const visit = (at: string, depth: number): void => {
    if (depth > 8 || seen.has(at)) return
    seen.add(at)
    const cfg = read(at)
    if (cfg === null) return
    out.push(cfg)
    const ext = typeof cfg.extends === 'string' ? [cfg.extends] : cfg.extends
    if (!Array.isArray(ext)) return
    for (const e of [...ext].reverse()) {
      if (typeof e !== 'string') continue
      const next = resolveBase(path.dirname(at), e)
      if (next !== null) visit(next, depth + 1)
    }
  }
  visit(file, 0)
  return out
}

/** Where tsc finds an `extends` entry: a path, or a package's file. */
function resolveBase(from: string, spec: string): string | null {
  if (spec.startsWith('.') || path.isAbsolute(spec))
    return path.resolve(from, spec.endsWith('.json') ? spec : `${spec}.json`)
  for (const s of spec.endsWith('.json') ? [spec] : [spec, `${spec}.json`, `${spec}/tsconfig.json`])
    try {
      return Bun.resolveSync(s, from)
    } catch {}
  return null
}

/**
 * Is `config` (absolute) taken in by a sealing tsconfig (`tsconfig*.json`)
 * in its directory or one above it, below `root`? The root's own project
 * holds the preset, so it refuses nothing.
 */
export function sealsConfig(root: string, config: string): boolean {
  for (let dir = path.dirname(config); dir !== root && dir.startsWith(root);) {
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => /^tsconfig.*\.json$/.test(n))
    } catch {}
    const rel = path.relative(dir, config).split(path.sep).join('/')
    if (names.some((n) => seals(path.join(dir, n), rel))) return true
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return false
}
