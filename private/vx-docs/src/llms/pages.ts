// The site as plain markdown for AI agents (2026-10-08: vx is AI
// first). Every docs page is served raw beside its HTML (`<page>.md`),
// llms.txt indexes them, llms-full.txt is all of them in one file.
import { getCollection, type CollectionEntry } from 'astro:content'
import { fillBench } from '../bench/data.ts'

export type Page = CollectionEntry<'docs'>

/** The pages an agent reads: everything but drafts and the 404. */
export async function agentPages(): Promise<Page[]> {
  const pages = await getCollection('docs', (e) => e.id !== '404' && e.data.draft !== true)
  return pages.sort((a, b) => a.id.localeCompare(b.id))
}

/** One page as markdown: its title as a heading, its description, its body. */
export function pageMarkdown(p: Page): string {
  const description = p.data.description ? `\n\n> ${p.data.description}` : ''
  // An MDX page's component imports mean nothing to a reader.
  const body = fillBench(p.body ?? '')
    .replace(/^import .+ from '@astrojs\/starlight\/components'\n/gm, '')
    .trim()
  return `# ${p.data.title}${description}\n\n${body}\n`
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
