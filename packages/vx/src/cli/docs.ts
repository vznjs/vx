// `vx docs <query> [--limit N] [--format pretty|json]` — search vx's
// reference as this version wrote it: packages/vx/docs at its git tag on
// GitHub, read online (2026-10-17: nothing is embedded). Each page is
// cut at its headings, and the sections holding every query word print
// whole, best first.

import { VERSION } from '../version.js'
import { parseDecimalInt } from '../util/index.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'

const SITE = 'https://vznjs.github.io/vx/'
const DEFAULT_LIMIT = 3
const REPO = 'vznjs/vx'
const DIR = 'packages/vx/docs'

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
      if (v === undefined || v === '') {
        return {
          ...out,
          error: `--limit requires a value: a whole number above 0${seeHelp('docs')}`,
        }
      }
      const n = parseDecimalInt(v)
      if (n === null || n < 1) {
        return {
          ...out,
          error: `--limit takes a whole number above 0 (got ${v})${seeHelp('docs')}`,
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

/** A page's URL on the site, as private/vx-docs/scripts/import-docs.ts serves it. */
function pageUrl(page: string): string {
  const served: Record<string, string> = {
    README: 'overview',
    features: 'all-features',
    'turbo-nx-support': 'compare/turbo-nx-support',
  }
  return `${SITE}${served[page] ?? page.toLowerCase()}/`
}

/** The git ref this vx's docs are at: its release tag; a source checkout (0.0.0) reads main. */
export function docsRef(version: string = VERSION): string {
  return version === '0.0.0' ? 'main' : `v${version}`
}

/**
 * Every page of packages/vx/docs at `ref` (its own `.md` files, the
 * maintainers' STATUS.md aside), page name → markdown. One listing, then
 * the pages at once. Throws with what failed; a token in GITHUB_TOKEN or
 * GH_TOKEN lifts GitHub's anonymous listing limit.
 */
export async function loadPages(
  ref: string,
  get: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN']
  const listing = await get(
    `https://api.github.com/repos/${REPO}/contents/${DIR}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  )
  if (!listing.ok) throw new Error(`GitHub answered ${listing.status} listing ${DIR} at ${ref}`)
  const names = ((await listing.json()) as Array<{ name: string; type: string }>)
    .filter((e) => e.type === 'file' && e.name.endsWith('.md') && e.name !== 'STATUS.md')
    .map((e) => e.name)
  const texts = await Promise.all(
    names.map(async (name) => {
      const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${DIR}/${name}`
      const r = await get(url)
      if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${url}`)
      return r.text()
    }),
  )
  return Object.fromEntries(names.map((n, i) => [n.slice(0, -3), texts[i]!]))
}

interface Section {
  page: string
  heading: string
  /** The heading's id on the site; absent for the page's opening. */
  id?: string
  text: string
}

/** Cut a page at its headings (outside code fences); the text before the first is the page's own. */
function sections(page: string, md: string): Section[] {
  const out: Section[] = []
  let heading = ''
  let id: string | undefined
  let lines: string[] = []
  let fence = false
  // The site numbers a repeated id (`usage`, `usage-1`) over every `##` to
  // `######` heading of the page, as import-docs.ts's `headingIds` does:
  // cli.md repeats Usage per verb, and each linked the first.
  const seen = new Map<string, number>()
  const flush = () => {
    const text = lines.join('\n').trim()
    if (text !== '') out.push({ page, heading, ...(id !== undefined ? { id } : {}), text })
  }
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : /^(#{1,6}) (.+)$/.exec(line)
    let slug: string | undefined
    if (h !== null && h[1]!.length > 1) {
      const base = anchor(h[2]!.replace(/`/g, '').trim())
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      slug = n === 0 ? base : `${base}-${n}`
    }
    if (h !== null && h[1]!.length <= 4) {
      flush()
      heading = h[2]!.replace(/`/g, '').trim()
      id = slug ?? anchor(heading)
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
    url: s.id === undefined ? pageUrl(s.page) : `${pageUrl(s.page)}#${s.id}`,
    text: s.text,
  }))
}

export async function docsCmd(
  args: readonly string[],
  load: (ref: string) => Promise<Record<string, string>> = loadPages,
): Promise<number> {
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
  const ref = docsRef()
  let pages: Record<string, string>
  try {
    pages = await load(ref)
  } catch (err) {
    return refuse(
      'docs',
      args,
      `cannot read the docs at ${ref} from GitHub (${err instanceof Error ? err.message : String(err)}); they are on the site, ${SITE}`,
      'VX_E_NETWORK',
    )
  }
  const hits = searchDocs(pages, parsed.terms, parsed.limit)
  const query = parsed.terms.join(' ')
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ query, hits })}\n`)
    return 0
  }
  if (hits.length === 0) {
    process.stdout.write(
      `vx docs: no section of the docs at ${ref} holds every word of "${query}"; try fewer words, or ${SITE}llms.txt\n`,
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
