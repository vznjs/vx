// Every feature in packages/vx/docs/features.md (imported as the
// `all-features` page), read for the hub's full list. The file is the
// source of truth; this only parses its one-line-per-feature shape.

import { getEntry } from 'astro:content'

export interface Item {
  name: string
  surface: string
  line: string
  /** Base-relative: its feature page, else its post, else none. */
  href?: string
  post?: string
}

export interface Group {
  title: string
  items: Item[]
}

const SITE = 'https://vznjs.github.io/vx/'

function local(href: string, base: string): string {
  return href.startsWith(SITE) ? base + href.slice(SITE.length) : href
}

export async function inventory(base: string): Promise<Group[]> {
  const entry = await getEntry('docs', 'all-features')
  if (entry === undefined) throw new Error('all-features page missing: run the import task')
  const groups: Group[] = []
  for (const row of (entry.body ?? '').split('\n')) {
    const head = /^## (.+)/.exec(row)
    if (head !== null) groups.push({ title: head[1]!, items: [] })
    const m = /^- \*\*(.+?)\*\*(?: \((.+?)\))? — (.+)$/.exec(row)
    if (m === null || groups.length === 0) continue
    const rest = m[3]!
    const page = /\[page\]\(([^)]+)\)/.exec(rest)?.[1]
    const post = /post: \[[^\]]+\]\(([^)]+)\)/.exec(rest)?.[1]
    const line = rest.replace(/\s*(?:\[page\]|post:|no post).*$/, '').replace(/\s*·$/, '')
    const item: Item = { name: m[1]!, surface: m[2] ?? '', line }
    const href = page ?? post
    if (href !== undefined) item.href = local(href, base)
    if (post !== undefined) item.post = local(post, base)
    groups.at(-1)!.items.push(item)
  }
  return groups.filter((g) => g.items.length > 0)
}
