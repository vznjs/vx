// A Starlight custom property the theme never defines resolves to nothing,
// so `font-family: var(--sl-font-mono)` fell back to the inherited
// proportional font and the caching widget's keys lost their columns.
// `--sl-font-mono` is one a SITE may set; Starlight only reads it through a
// fallback. So every `var(--sl-…)` here either names a property Starlight's
// own stylesheets define, or carries a fallback of its own.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..')
const STARLIGHT_STYLE = path.join(ROOT, 'node_modules', '@astrojs', 'starlight', 'dist', 'style')

function filesUnder(dir: string, exts: readonly string[]): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && exts.some((x) => e.name.endsWith(x)))
    .map((e) => path.join(e.parentPath, e.name))
}

describe("the site's Starlight custom properties", () => {
  const defined = new Set<string>()
  for (const file of filesUnder(STARLIGHT_STYLE, ['.css'])) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(--sl-[\w-]+)\s*:/g)) defined.add(m[1]!)
  }

  it('reads Starlight’s definitions, including the ones a site overrides through', () => {
    expect(defined.has('--sl-font-system-mono')).toBe(true)
    expect(defined.has('--sl-color-gray-5')).toBe(true)
    expect(defined.has('--sl-font-mono')).toBe(false)
  })

  it('uses only defined ones, or gives the rest a fallback', () => {
    const bare: string[] = []
    for (const file of filesUnder(path.join(ROOT, 'src'), ['.astro', '.css', '.ts', '.mdx'])) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\(\s*(--sl-[\w-]+)\s*\)/g)) {
        if (!defined.has(m[1]!)) bare.push(`${path.relative(ROOT, file)}: ${m[1]}`)
      }
    }
    expect(bare).toEqual([])
  })
})
