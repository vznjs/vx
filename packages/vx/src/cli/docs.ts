// `vx docs <query> [--limit N] [--format pretty|json]` — search vx's
// reference offline, for an agent that cannot reach the site: each page is
// cut at its headings, and the sections holding every query word print
// whole, best first.

import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'

const SITE = 'https://vznjs.github.io/vx/'
const DEFAULT_LIMIT = 3

interface DocsArgs {
  terms: string[]
  limit: number
  json: boolean
  error?: string
}

function parseDocsArgs(args: readonly string[]): DocsArgs {
  const out: DocsArgs = { terms: [], limit: DEFAULT_LIMIT, json: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--format' || a.startsWith('--format=')) {
      const fv = formatValue(a === '--format' ? args[++i] : a.slice('--format='.length), 'docs')
      if (typeof fv === 'object') return { ...out, error: fv.error }
      out.json = fv === 'json'
    } else if (a === '--limit' || a.startsWith('--limit=')) {
      const v = a === '--limit' ? args[++i] : a.slice('--limit='.length)
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1) {
        return {
          ...out,
          error: `--limit takes a whole number above 0 (got ${v ?? 'nothing'})${seeHelp('docs')}`,
        }
      }
      out.limit = n
    } else if (a.startsWith('-')) {
      return { ...out, error: `${refusedWord(a)}: ${a}${flagHint('docs', a)}${seeHelp('docs')}` }
    } else out.terms.push(...words(a))
  }
  return out
}

export interface DocsHit {
  page: string
  heading: string
  url: string
  text: string
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []
}

/** GitHub's heading anchor, which Starlight shares: lowercase, punctuation dropped, spaces to `-`. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

/** A page's URL on the site; `features.md` is served as `all-features/`. */
function pageUrl(page: string): string {
  return `${SITE}${page === 'features' ? 'all-features' : page}/`
}

interface Section {
  page: string
  heading: string
  text: string
}

/** Cut a page at its headings (outside code fences); the text before the first is the page's own. */
function sections(page: string, md: string): Section[] {
  const out: Section[] = []
  let heading = ''
  let lines: string[] = []
  let fence = false
  const flush = () => {
    const text = lines.join('\n').trim()
    if (text !== '') out.push({ page, heading, text })
  }
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : /^#{1,4} (.+)$/.exec(line)
    if (h !== null) {
      flush()
      heading = h[1]!.replace(/`/g, '').trim()
      lines = [line]
    } else lines.push(line)
  }
  flush()
  return out
}

function count(hay: string, term: string): number {
  let n = 0
  for (let i = hay.indexOf(term); i !== -1; i = hay.indexOf(term, i + term.length)) n++
  return n
}

/**
 * The sections holding every term, best first: a term in the heading
 * outweighs any count in the text. A section titled by the one word asked
 * (an error code) is the answer alone.
 */
export function searchDocs(
  pages: Readonly<Record<string, string>>,
  terms: readonly string[],
  limit: number,
): DocsHit[] {
  const scored: { s: Section; score: number; order: number }[] = []
  let order = 0
  for (const [page, md] of Object.entries(pages)) {
    for (const s of sections(page, md)) {
      order++
      const head = s.heading.toLowerCase()
      const body = s.text.toLowerCase()
      let score = 0
      let all = true
      for (const t of terms) {
        const inBody = count(body, t)
        if (inBody === 0) all = false
        score += (head.includes(t) ? 10 : 0) + Math.min(inBody, 5)
      }
      if (all) scored.push({ s, score, order })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  const exact =
    terms.length === 1 ? scored.filter(({ s }) => words(s.heading).join(' ') === terms[0]) : []
  return (exact.length > 0 ? exact : scored).slice(0, limit).map(({ s }) => ({
    page: s.page,
    heading: s.heading,
    url: s.heading === '' ? pageUrl(s.page) : `${pageUrl(s.page)}#${anchor(s.heading)}`,
    text: s.text,
  }))
}

export async function docsCmd(args: readonly string[]): Promise<number> {
  const parsed = parseDocsArgs(args)
  if (parsed.error) return refuse('docs', args, parsed.error, 'VX_E_USAGE')
  if (parsed.terms.length === 0) {
    return refuse(
      'docs',
      args,
      `name what to look for, as in \`vx docs cache inputs\`${seeHelp('docs')}`,
      'VX_E_USAGE',
    )
  }
  const { PAGES } = await import('./docs-corpus.js')
  const hits = searchDocs(PAGES, parsed.terms, parsed.limit)
  const query = parsed.terms.join(' ')
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ query, hits })}\n`)
    return 0
  }
  if (hits.length === 0) {
    process.stdout.write(
      `vx docs: no section of ${Object.keys(PAGES).join(', ')} holds every word of "${query}"; try fewer words, or ${SITE}llms.txt\n`,
    )
    return 0
  }
  process.stdout.write(
    hits
      .map(
        (h) =>
          `── ${h.page}.md${h.heading === '' ? '' : ` § ${h.heading}`} · ${h.url}\n\n${h.text}\n`,
      )
      .join('\n'),
  )
  return 0
}
