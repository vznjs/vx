// The docs collection's pages as the paths they are served at, for the rows
// that compare a list of pages with the collection (sidebar-coverage,
// redirects). Astro slugs each path segment the way github-slugger does:
// lower case, punctuation dropped, spaces to hyphens — so `roadmap-1.0.md`
// is served at `roadmap-10/`.

import { readdirSync } from 'node:fs'
import path from 'node:path'

const CONTENT = path.resolve(import.meta.dir, '../src/content/docs')

function slug(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Each page under `dir` (the whole collection by default), as `a/b/` under the base. */
export function collectionPages(dir = ''): string[] {
  return readdirSync(path.join(CONTENT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => {
      const parts = path
        .join(dir, f)
        .split(path.sep)
        .map((s, i, all) => (i === all.length - 1 ? s.replace(/\.mdx?$/, '') : s))
      if (parts.at(-1) === 'index') parts.pop()
      return parts.map((s) => `${slug(s)}/`).join('')
    })
    .sort()
}
