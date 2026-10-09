// A package whose tsconfig is a composite project (or sets `rootDir`)
// refuses a source file outside its directory: withastro/astro's
// `scripts/tsconfig.json` type-checked the written `vx.config.mjs`, and its
// import of the root `vx-preset.mjs` failed the build (TS6059, TS6307). Such
// a package's config declares the preset values it uses itself.

import { readFileSync } from 'node:fs'
import path from 'node:path'

type TsConfig = {
  extends?: unknown
  include?: unknown
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

/** Does `dir/tsconfig.json` take `dir/<config>` into a project that refuses files outside `dir`? */
export function sealsConfig(dir: string, config: string): boolean {
  const own = read(path.join(dir, 'tsconfig.json'))
  if (own === null) return false
  // `include` and `files` are not inherited past the file that sets them
  // relative to it; the compiler options are, through `extends`.
  let sealed = false
  let at: TsConfig | null = own
  let from = dir
  for (let depth = 0; at !== null && depth < 8; depth++) {
    const o = at.compilerOptions
    if (o?.composite === true || typeof o?.rootDir === 'string') {
      sealed = true
      break
    }
    const ext = at.extends
    // A package name (`@tsconfig/node20`) seals nothing a repo would ship.
    if (typeof ext !== 'string' || !ext.startsWith('.')) break
    const file = path.resolve(from, ext.endsWith('.json') ? ext : `${ext}.json`)
    from = path.dirname(file)
    at = read(file)
  }
  if (!sealed) return false
  if (Array.isArray(own.include))
    return own.include.some(
      (g) => typeof g === 'string' && new Bun.Glob(g.replace(/^\.\//, '')).match(config),
    )
  // `files` alone lists exactly what it compiles.
  return !Array.isArray(own.files)
}
