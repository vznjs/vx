// A tsconfig that is a composite project (or sets `rootDir`) refuses a
// source file outside its directory: withastro/astro's
// `scripts/tsconfig.json` type-checked the written `vx.config.mjs`, and its
// import of the root `vx-preset.mjs` failed the build (TS6059, TS6307). So
// did `packages/astro/tsconfig.test.json`, which takes in the nested
// `performance/vx.config.mjs`. A config such a project takes in declares
// the preset values it uses itself.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

type TsConfig = {
  extends?: unknown
  include?: unknown
  exclude?: unknown
  files?: unknown
  compilerOptions?: { composite?: unknown; rootDir?: unknown }
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

/** Does the project `file` states take in `rel` (relative to its directory) and refuse files outside it? */
function seals(file: string, rel: string): boolean {
  let sealed: boolean | undefined
  let include: unknown
  let exclude: unknown
  let files: unknown
  let at: TsConfig | null = read(file)
  let from = path.dirname(file)
  // The nearest file that states a field decides it, as `extends` resolves.
  for (let depth = 0; at !== null && depth < 8; depth++) {
    const o = at.compilerOptions
    if (sealed === undefined && o?.composite !== undefined) sealed = o.composite === true
    if (sealed !== true && typeof o?.rootDir === 'string') sealed = true
    include ??= at.include
    exclude ??= at.exclude
    files ??= at.files
    const ext = at.extends
    // A package (`@tsconfig/node20`) is not followed: what it seals is rare.
    if (typeof ext !== 'string' || !ext.startsWith('.')) break
    const next = path.resolve(from, ext.endsWith('.json') ? ext : `${ext}.json`)
    from = path.dirname(next)
    at = read(next)
  }
  if (sealed !== true) return false
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
