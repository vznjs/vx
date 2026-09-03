// The docs site imports `docs/` (apps/docs/scripts/import-docs.ts) and lists
// pages by hand in the Starlight sidebar. Two pages were imported and reachable
// from no sidebar entry (2026-09-03: the overview, i.e. docs/README.md, and a
// stale second pitch). This pins both directions: every imported top-level doc
// is named in the sidebar, and every sidebar link has a page — a hand-listed
// sidebar cannot drift from the tree silently.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '../../..')
const DOCS = path.join(REPO, 'docs')
const SITE = path.join(REPO, 'apps/docs')
const CONTENT = path.join(SITE, 'src/content/docs')

function sidebarLinks(): Set<string> {
  const cfg = readdirSync(SITE)
    .filter((f) => f.startsWith('astro.config.'))
    .map((f) => readFileSync(path.join(SITE, f), 'utf8'))
    .join('\n')
  return new Set([...cfg.matchAll(/link:\s*'([^']+)'/g)].map((m) => m[1]!))
}

/** The clean URL import-docs.ts gives a top-level docs/*.md file. */
function urlOf(file: string): string | null {
  if (file === 'STATUS.md') return null // the maintainers' handoff, never imported
  if (file === 'README.md') return '/overview/'
  return `/${file.replace(/\.md$/, '')}/`
}

describe('docs site sidebar coverage', () => {
  const links = sidebarLinks()

  // The site's .gitignore is the manifest of generated top-level pages:
  // import-docs.ts clears exactly that set before regenerating, so a source
  // deleted from docs/ cannot leave a stale page behind — but only while the
  // list and the tree agree.
  it('the site .gitignore lists exactly the imported top-level pages', () => {
    const ignored = readFileSync(path.join(SITE, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/src/content/docs/') && l.endsWith('.md'))
      .map((l) => l.slice('/src/content/docs/'.length))
      .sort()
    const imported = readdirSync(DOCS)
      .filter((f) => f.endsWith('.md') && f !== 'STATUS.md')
      .map((f) => (f === 'README.md' ? 'overview.md' : f))
      .sort()
    expect(ignored).toEqual(imported)
  })

  it('names every imported top-level doc', () => {
    const orphans = readdirSync(DOCS)
      .filter((f) => f.endsWith('.md'))
      .map(urlOf)
      .filter((u): u is string => u !== null && !links.has(u))
    expect(orphans).toEqual([])
  })

  it('links only to pages that exist (authored, or imported by the last build)', () => {
    // Guides and concepts are authored under apps/docs; the rest is imported
    // from docs/ by `import-docs.ts`. Check the SOURCE for imported ones so the
    // pin does not depend on a stale generated copy.
    const missing = [...links].filter((link) => {
      const rel = link.replace(/^\//, '').replace(/\/$/, '')
      const authored = [`${rel}.md`, `${rel}.mdx`, `${rel}/index.md`, `${rel}/index.mdx`].some(
        (c) => existsSync(path.join(CONTENT, c)),
      )
      const imported =
        rel === 'overview'
          ? existsSync(path.join(DOCS, 'README.md'))
          : existsSync(path.join(DOCS, `${rel}.md`))
      return !authored && !imported
    })
    expect(missing).toEqual([])
  })
})
