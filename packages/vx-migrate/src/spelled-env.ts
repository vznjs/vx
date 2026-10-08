// The env names a package's tracked source spells: what stands in, in a
// written config, for a `*` env entry Turbo or Vite Task matched against
// the environment a run sees.

import path from 'node:path'
import { relPosix } from './paths.js'

/** Source and env-example files a framework build reads its variables from. */
const SPELLS_ENV =
  /\.(c|m)?(j|t)sx?$|\.(vue|svelte|astro|html)$|(^|\/)\.env\.(example|sample|template)$/

/**
 * The upper-case names the tracked source under `dirs` spells (`NEXT_PUBLIC_API`
 * in `process.env.NEXT_PUBLIC_API` or an `.env.example`), sorted. Without
 * git, none: the note still names the framework's prefix.
 */
export async function spelledNames(
  root: string,
  dirs: readonly string[],
  tracked: readonly string[] | null,
): Promise<string[]> {
  if (tracked === null) return []
  const prefixes = dirs.map((dir) => {
    const rel = relPosix(root, dir)
    return rel === '' || rel === '.' ? '' : `${rel}/`
  })
  const names = new Set<string>()
  for (const f of tracked) {
    if (!SPELLS_ENV.test(f) || !prefixes.some((p) => f.startsWith(p))) continue
    const text = await Bun.file(path.join(root, f))
      .text()
      .catch(() => '')
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\b/g)) names.add(m[0])
  }
  return [...names].sort()
}
