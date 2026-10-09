// The site's posts, read once from the docs collection: the blog's essays
// (src/content/docs/blog/) and the release notes (src/content/docs/
// releases/), and what every view shows of them: the version chip a
// release carries, the topic filters, the related posts under a post.

import { getCollection, type CollectionEntry } from 'astro:content'
import { FALLBACK, TONES } from './tones.js'

export type Author = { name: string; title: string; url: string }

export const AUTHORS: Record<string, Author> = {
  vzn: { name: 'vzn', title: 'vx maintainer', url: 'https://github.com/vznjs' },
}

/** Where a post lives: the blog (essays) or the Releases section. */
export type Kind = 'blog' | 'releases'

export type Post = {
  entry: CollectionEntry<'docs'>
  kind: Kind
  slug: string
  href: string
  title: string
  excerpt: string
  date: Date
  tags: string[]
  authors: Author[]
  /** `v0.0.625` for a release post, from its slug. */
  version: string | undefined
}

/** A filter on the blog's listing: a tag page. */
export type Filter = { id: string; label: string }

// The chips over the blog's grid: the topics with enough posts to be worth
// a chip. Every other tag keeps its page.
export const FILTERS: Filter[] = [
  { id: 'caching', label: 'Caching' },
  { id: 'performance', label: 'Performance' },
  { id: 'execution', label: 'Execution' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'dx', label: 'DX' },
  { id: 'internals', label: 'Internals' },
  { id: 'migration', label: 'Migration' },
]

const base = import.meta.env.BASE_URL

export const blogHref = (p = ''): string => `${base}blog/${p}`
export const sectionHref = (kind: Kind, p = ''): string => `${base}${kind}/${p}`

let cached: Post[] | undefined

const kindOf = (id: string): Kind | undefined =>
  id.startsWith('blog/') ? 'blog' : id.startsWith('releases/') ? 'releases' : undefined

/** Every published post of a kind, newest first; a same-day tie goes by title. */
export async function posts(kind: Kind = 'blog'): Promise<Post[]> {
  return (await all()).filter((p) => p.kind === kind)
}

/** The post a route id names (`blog/hello-vx`, `releases/vx-0-0-625`). */
export async function postAt(id: string): Promise<Post | undefined> {
  return (await all()).find((p) => p.entry.id === id)
}

async function all(): Promise<Post[]> {
  if (cached) return cached
  const entries = await getCollection(
    'docs',
    (e) => kindOf(e.id) !== undefined && !(import.meta.env.PROD && e.data.draft),
  )
  cached = entries
    .map((entry): Post => {
      const kind = kindOf(entry.id)!
      const slug = entry.id.slice(kind.length + 1)
      const { date, excerpt } = entry.data
      if (!date || !excerpt)
        throw new Error(`${entry.filePath}: a post needs a date and an excerpt`)
      const authors = (entry.data.authors ?? []).map((key) => {
        const a = AUTHORS[key]
        if (!a) throw new Error(`${entry.filePath}: unknown author ${key}`)
        return a
      })
      const v = kind === 'releases' ? /^vx-(\d+)-(\d+)-(\d+)$/.exec(slug) : null
      if (kind === 'releases' && !v)
        throw new Error(`${entry.filePath}: a release is vx-<x>-<y>-<z>.md`)
      return {
        entry,
        kind,
        slug,
        href: sectionHref(kind, `${slug}/`),
        title: entry.data.title,
        excerpt,
        date,
        tags: entry.data.tags ?? [],
        authors,
        version: v ? `v${v[1]}.${v[2]}.${v[3]}` : undefined,
      }
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime() || a.title.localeCompare(b.title))
  return cached
}

export const matches = (p: Post, filter: string): boolean => p.tags.includes(filter)

/** Every filter a blog page exists for: each tag an essay carries. */
export async function filters(): Promise<Filter[]> {
  const ids = new Set((await posts()).flatMap((p) => p.tags))
  return [...ids].map((id) => FILTERS.find((f) => f.id === id) ?? { id, label: id })
}

export const formatDate = (d: Date): string =>
  d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

/**
 * Three posts to read next: the nearest releases for a release, the essays
 * sharing the most tags for an essay, newer first on a tie.
 */
export async function related(self: Post): Promise<Post[]> {
  const same = await posts(self.kind)
  const others = same.filter((p) => p !== self)
  if (self.kind === 'releases') {
    const at = same.indexOf(self)
    return others
      .sort((a, b) => Math.abs(same.indexOf(a) - at) - Math.abs(same.indexOf(b) - at))
      .slice(0, 3)
  }
  const shared = (p: Post): number => p.tags.filter((t) => self.tags.includes(t)).length
  return others
    .map((p, i) => ({ p, i, n: shared(p) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.p)
}

/** A drawn cover's hue (src/blog/tones.ts). */
export function tone(p: Post): string {
  for (const t of p.tags) for (const [tags, c] of TONES) if (tags.includes(t)) return c
  return FALLBACK
}

/** The label a post's kicker and cover show: its version, else its first filter's name. */
export function label(p: Post): string {
  if (p.version) return p.version
  const f = p.tags.map((t) => FILTERS.find((x) => x.id === t)).find((x) => x)
  return f?.label ?? p.tags[0] ?? 'Essay'
}
