// The site as plain markdown for AI agents (2026-10-08: vx is AI
// first). Every docs page is served raw beside its HTML (`<page>.md`),
// llms.txt indexes them, llms-full.txt is all of them in one file.
import { getCollection, type CollectionEntry } from 'astro:content'
import { fillBench } from '../bench/data.ts'
import { SIDEBAR } from '../nav/sections.ts'

export type Page = CollectionEntry<'docs'>

/** The pages an agent reads: everything but drafts and the 404. */
export async function agentPages(): Promise<Page[]> {
  const pages = await getCollection('docs', (e) => e.id !== '404' && e.data.draft !== true)
  return pages.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * One page as markdown: its title as a heading, its description, its body.
 * `base` is the site's root URL: a relative link in the body is written
 * for the page's HTML (`docs/ci/`), one level deeper than its `.md`, so
 * each one is resolved there and, where it names a page, points at that
 * page's markdown. An agent following `../ci/` from `docs/troubleshooting.md`
 * reached a 404.
 */
export function pageMarkdown(p: Page, base: string, ids: ReadonlySet<string>): string {
  const description = p.data.description ? `\n\n> ${p.data.description}` : ''
  const page = new URL(p.id === 'index' ? '' : `${p.id}/`, base)
  const body = fillBench(p.body ?? '')
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => (i % 2 === 1 ? part : prose(part, page, base, ids)))
    .join('')
    .trim()
  return `# ${p.data.title}${description}\n\n${body}\n`
}

/** Markdown outside code fences, with MDX's components spelled as markdown. */
function prose(md: string, page: URL, base: string, ids: ReadonlySet<string>): string {
  const link = (to: string): string => absolute(to, page, base, ids)
  return (
    md
      // An MDX page's imports mean nothing to a reader.
      .replace(/^import .+ from '[^']+'\n/gm, '')
      .replace(
        /<LinkCard\s+title="([^"]*)"(?:\s+description="([^"]*)")?\s+href="([^"]*)"\s*\/>/g,
        (_, title: string, note: string | undefined, to: string) =>
          `- [${title}](${link(to)})${note ? `: ${note}` : ''}`,
      )
      .replace(/<(?:Aside|TabItem)\b[^>]*?\b(?:title|label)="([^"]*)"[^>]*>/g, '**$1**')
      .replace(/<Aside\b[^>]*>/g, '**Note**')
      .replace(/^[ \t]*<\/?(?:CardGrid|Steps|Tabs|TabItem|Aside)\b[^>]*>[ \t]*\n/gm, '')
      .replace(/^[ \t]*<(?:Diagram|GraphExplorer)\b[^>]*\/>[ \t]*\n/gm, '')
      .replace(/\]\(([^)\s]+)\)/g, (_, to: string) => `](${link(to)})`)
      .replace(/\bhref="([^"]+)"/g, (_, to: string) => `href="${link(to)}"`)
  )
}

/** A link as an absolute URL; one to a page an agent reads (`ids`) names its `.md`. */
function absolute(to: string, page: URL, base: string, ids: ReadonlySet<string>): string {
  if (/^[a-z][a-z+.-]*:/i.test(to) || to.startsWith('#')) return to
  const url = new URL(to, page)
  if (!url.href.startsWith(base) || !url.pathname.endsWith('/')) return url.href
  const id = url.pathname.slice(new URL(base).pathname.length).replace(/\/$/, '') || 'index'
  return ids.has(id) ? `${base}${id}.md${url.hash}` : url.href
}

/** Where a page's markdown lives, under the site's base. */
export function markdownUrl(p: Page, base: string): string {
  return `${base}${p.id === 'index' ? 'index' : p.id}.md`
}

const INTERNAL_PAGES = new Set([
  'overview',
  'architecture',
  'optimizations',
  'patterns',
  'flows',
  'parity',
  'upstream-ledger',
  'modules',
  'design',
])

/** How vx is built, not how to use it. */
export function isInternal(id: string): boolean {
  return INTERNAL_PAGES.has(id) || id.startsWith('modules/') || id.startsWith('design/')
}

type Item = { label?: string; link?: string; items?: Item[] }
const pageId = (link: string): string => link.replace(/^\/|\/$/g, '') || 'index'
const linked = (items: readonly Item[]): string[] =>
  items.flatMap((i) => (i.items ? linked(i.items) : i.link ? [pageId(i.link)] : []))

/**
 * The docs in the sidebar's order, one section per sidebar group, then
 * every other user page under `More docs`: the path a new user walks
 * (M 2026-11-23), so an agent reading top-down meets the quickstart before
 * the reference. Blog, releases and internals are left out.
 */
export function readingOrder(pages: readonly Page[]): [string, Page[]][] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const take = (ids: string[]): Page[] =>
    ids.flatMap((id) => {
      const p = byId.get(id)
      if (!p || seen.has(p.id)) return []
      seen.add(p.id)
      return [p]
    })
  const docs = (SIDEBAR as Item[]).find((g) => g.label === 'Docs')?.items ?? []
  const groups = docs
    .filter((i) => i.items)
    .map((g): [string, Page[]] => [g.label!, take(linked(g.items!))])
  const more = take([
    ...linked(docs.filter((i) => !i.items)),
    ...pages.filter((p) => !/^(blog|releases)\//.test(p.id) && !isInternal(p.id)).map((p) => p.id),
  ])
  const all: [string, Page[]][] = [...groups, ['More docs', more]]
  return all.filter(([, ps]) => ps.length > 0)
}
