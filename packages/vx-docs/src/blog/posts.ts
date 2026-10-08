// The blog's posts, read once from the docs collection (src/content/docs/
// blog/), and what every blog view shows of them: the version chip a
// release carries, the topic filters, the related posts under a post.

import { getCollection, type CollectionEntry } from 'astro:content'

export type Author = { name: string; title: string; url: string }

export const AUTHORS: Record<string, Author> = {
  vzn: { name: 'vzn', title: 'vx maintainer', url: 'https://github.com/vznjs' },
}

export type Post = {
  entry: CollectionEntry<'docs'>
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

/** A filter on the listing: a tag page, or `essays`, every post but the releases. */
export type Filter = { id: string; label: string }

// The chips over the grid: the two kinds of post, then the topics with
// enough posts to be worth a chip. Every other tag keeps its page.
export const FILTERS: Filter[] = [
  { id: 'release', label: 'Releases' },
  { id: 'essays', label: 'Essays' },
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

let cached: Post[] | undefined

/** Every published post, newest first; a same-day tie goes by title. */
export async function posts(): Promise<Post[]> {
  if (cached) return cached
  const entries = await getCollection(
    'docs',
    (e) => e.id.startsWith('blog/') && !(import.meta.env.PROD && e.data.draft),
  )
  cached = entries
    .map((entry): Post => {
      const slug = entry.id.slice('blog/'.length)
      const { date, excerpt } = entry.data
      if (!date || !excerpt)
        throw new Error(`${entry.filePath}: a post needs a date and an excerpt`)
      const authors = (entry.data.authors ?? []).map((key) => {
        const a = AUTHORS[key]
        if (!a) throw new Error(`${entry.filePath}: unknown author ${key}`)
        return a
      })
      const v = /^vx-(\d+)-(\d+)-(\d+)$/.exec(slug)
      return {
        entry,
        slug,
        href: blogHref(`${slug}/`),
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

export const matches = (p: Post, filter: string): boolean =>
  filter === 'essays' ? p.version === undefined : p.tags.includes(filter)

/** Every filter a page exists for: each tag, and `essays`. */
export async function filters(): Promise<Filter[]> {
  const all = await posts()
  const ids = new Set(['essays', ...all.flatMap((p) => p.tags)])
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
 * Three posts to read next: the nearest releases for a release, the posts
 * sharing the most tags for an essay, newer first on a tie.
 */
export async function related(slug: string): Promise<Post[]> {
  const all = await posts()
  const self = all.find((p) => p.slug === slug)!
  const others = all.filter((p) => p !== self)
  if (self.version) {
    const at = all.indexOf(self)
    return others
      .filter((p) => p.version)
      .sort((a, b) => Math.abs(all.indexOf(a) - at) - Math.abs(all.indexOf(b) - at))
      .slice(0, 3)
  }
  const shared = (p: Post): number => p.tags.filter((t) => self.tags.includes(t)).length
  return others
    .filter((p) => !p.version)
    .map((p, i) => ({ p, i, n: shared(p) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.p)
}

// A cover drawn in CSS for a post without an image: its hue from its
// first tag that names one, from the landing's palette.
const TONES: [string[], string][] = [
  [['caching', 'correctness', 'sandbox'], '#5ee0ff'],
  [['performance', 'benchmarks', 'internals'], '#ff9d42'],
  [['plugins', 'execution', 'remote-execution', 'agents', 'telemetry', 'ci'], '#6aa8ff'],
  [['dx', 'config', 'migration', 'turborepo', 'nx', 'comparison'], '#ff5e9c'],
]

export function tone(p: Post): string {
  for (const t of p.tags) for (const [tags, c] of TONES) if (tags.includes(t)) return c
  return '#c6f84e'
}

/** The label a post's kicker and cover show: its version, else its first filter's name. */
export function label(p: Post): string {
  if (p.version) return p.version
  const f = p.tags.map((t) => FILTERS.find((x) => x.id === t)).find((x) => x)
  return f?.label ?? p.tags[0] ?? 'Essay'
}
