// The Guide (design/site-redo-2026-09.md): ten chapters read in order, each
// opening with its number, its title and the problem it answers, and ending
// with a card that names the next chapter. src/guide/chapters.ts is the one
// list the site numbers from; these rows hold it to the design's table (the
// imported copy of the design, so the site cannot drift from the page that
// binds it), to each chapter's frontmatter, and to what the build shipped.
//
// The design's table is the oracle, not chapters.ts: a row generated from
// the list it checks would agree with any list.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { AFTER_GUIDE, CHAPTERS, problemHtml } from '../src/guide/chapters.js'

const SITE = path.resolve(import.meta.dir, '..')
const DIST = path.join(SITE, 'dist')
const GUIDE_SRC = path.join(SITE, 'src/content/docs/guide')
const DESIGN = path.join(SITE, 'src/content/docs/design/site-redo-2026-09.md')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

function page(rel: string): string {
  const file = path.join(DIST, rel, 'index.html')
  if (!existsSync(file)) throw new Error(`${file} is missing: run the site's build task first`)
  return readFileSync(file, 'utf8')
}

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

/** The element with `cls` among its classes: its inner HTML. */
function inner(html: string, tag: string, cls: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*class="${cls}(?: [^"]*)?"[^>]*>([\\s\\S]*?)</${tag}>`).exec(
    html,
  )
  return m?.[1]
}

/** The design's table: number, slug, title and problem cell of each row. */
function designRows(): { chapter: number; slug: string; title: string; problem: string }[] {
  const md = readFileSync(DESIGN, 'utf8')
  return [...md.matchAll(/^\|\s*(\d+)\s*\|\s*`([\w-]+)\/`:\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)].map(
    (m) => ({ chapter: Number(m[1]), slug: m[2]!, title: m[3]!, problem: m[4]! }),
  )
}

/** A chapter file's frontmatter, as the flat `key: value` lines it is. */
function frontmatter(file: string): Record<string, string> {
  const src = readFileSync(file, 'utf8')
  const block = /^---\n([\s\S]*?)\n---\n/.exec(src)![1]!
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line)
    if (m === null) continue
    const raw = m[2]!
    out[m[1]!] = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw
  }
  return out
}

const stripEnd = (s: string): string => s.replace(/[.?]$/, '')

describe('the Guide', () => {
  it('has the design’s ten chapters, in its order, with its titles and problems', () => {
    const rows = designRows()
    expect(rows.map((r) => r.chapter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(CHAPTERS.map((c) => [c.chapter, c.slug, c.title])).toEqual(
      rows.map((r) => [r.chapter, r.slug, r.title]),
    )
    // The last chapter's cell is "—": the design gives it no problem, so the
    // site's is its own.
    const stated = rows.filter((r) => r.problem !== '—')
    expect(stated).toHaveLength(9)
    expect(stated.map((r) => stripEnd(CHAPTERS[r.chapter - 1]!.problem))).toEqual(
      stated.map((r) => stripEnd(r.problem)),
    )
  })

  it('has one source file per chapter, whose frontmatter agrees with the list', () => {
    expect(readdirSync(GUIDE_SRC).sort()).toEqual(CHAPTERS.map((c) => `${c.slug}.mdx`).sort())
    const wrong: string[] = []
    for (const c of CHAPTERS) {
      const fm = frontmatter(path.join(GUIDE_SRC, `${c.slug}.mdx`))
      const want = { title: c.title, chapter: String(c.chapter), problem: c.problem }
      for (const [k, v] of Object.entries(want)) {
        if (fm[k] !== v)
          wrong.push(`${c.slug}: ${k} is ${JSON.stringify(fm[k])}, not ${JSON.stringify(v)}`)
      }
      if (fm['description'] === undefined || fm['description'] === '') {
        wrong.push(`${c.slug}: no description`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('builds exactly the ten chapter pages under guide/', () => {
    const built = readdirSync(path.join(DIST, 'guide'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(built).toEqual(CHAPTERS.map((c) => c.slug).sort())
  })

  for (const c of CHAPTERS) {
    describe(`chapter ${c.chapter}, guide/${c.slug}/`, () => {
      const html = page(`guide/${c.slug}`)

      it('opens with its number, its title and its problem, before the text', () => {
        const head = inner(html, 'div', 'vx-chapter-head')
        expect(head).toBeDefined()
        expect(text(inner(head!, 'p', 'vx-chapter-number')!)).toBe(`Chapter ${c.chapter}`)
        const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
        expect(h1.map((m) => text(m[1]!))).toEqual([c.title])
        expect(h1[0]![0]).toContain('id="_top"')
        expect(inner(head!, 'p', 'vx-chapter-problem')).toBe(problemHtml(c.problem))
        expect(html.indexOf('vx-chapter-head')).toBeLessThan(html.indexOf('sl-markdown-content'))
        expect(html).toContain(`<title>${c.title} | vx</title>`)
      })

      it('ends with a one-line Next card naming the next chapter, or the quickstart after the last', () => {
        const next = CHAPTERS[c.chapter]
        const want =
          next === undefined
            ? {
                href: `${BASE}${AFTER_GUIDE.href}`,
                title: AFTER_GUIDE.title,
                problem: AFTER_GUIDE.problem,
              }
            : { href: `${BASE}guide/${next.slug}/`, title: next.title, problem: next.problem }
        const cards = [...html.matchAll(/<a\b[^>]*class="vx-next(?: [^"]*)?"[^>]*>/g)]
        expect(cards).toHaveLength(1)
        expect(cards[0]![0]).toContain(`href="${want.href}"`)
        const line = inner(inner(html, 'a', 'vx-next')!, 'span', 'vx-next-line')!
        // "Next: <title>. <problem>", with no second stop after a title's own.
        const stop = /[.?!]$/.test(want.title) ? '' : '.'
        expect(text(line)).toBe(`Next: ${want.title}${stop} ${want.problem.replace(/`/g, '')}`)
        expect(line).toContain(`<strong>${want.title}</strong>`)
        // The card replaces Starlight's prev/next pair.
        expect(html).not.toContain('class="pagination-links')
        expect(html.indexOf('sl-markdown-content')).toBeLessThan(html.indexOf('vx-next'))
      })

      it('carries exactly one picture once it is written (the last chapter, one or more)', () => {
        const src = readFileSync(path.join(GUIDE_SRC, `${c.slug}.mdx`), 'utf8')
        // A stub has none yet; its TODO goes when the chapter is written.
        if (src.includes('TODO(R2)')) return
        const n = pictures(html)
        // The last chapter is the playground and the labs.
        if (c.chapter === CHAPTERS.length) expect(n).toBeGreaterThan(0)
        else expect(n).toBe(1)
      })

      it('loads no Mermaid', () => {
        expect(html).not.toContain('class="mermaid"')
        expect(mermaidScripts(html)).toEqual([])
      })
    })
  }

  // The control for the row above: the detector sees the loader where it is.
  it('finds the Mermaid loader on a page that draws with Mermaid', () => {
    const html = page('flows')
    expect(html).toContain('class="mermaid"')
    expect(mermaidScripts(html).length).toBeGreaterThan(0)
  })

  // The control for the picture row: the counter sees a kit figure and a
  // widget, and does not count a checkpoint, which is a check, not a picture.
  it('counts a diagram figure and a widget as pictures, and a checkpoint as none', () => {
    expect(pictures(page('internals/diagrams'))).toBe(3)
    const caching = page('learn/caching')
    expect(caching).toContain('<vx-checkpoint')
    expect(pictures(caching)).toBe(1)
    expect(pictures('<figure class="vx-diagram" role="img"><svg></svg></figure>')).toBe(1)
  })

  it('renders a problem’s code spans as code, and escapes the rest', () => {
    expect(problemHtml('`a<b>` & "c"')).toBe('<code>a&lt;b&gt;</code> &amp; "c"')
  })
})

/** The pictures on a page: diagram figures (the kit's, or a hand-drawn SVG in
 *  `<figure class="vx-diagram">`) and widgets (`<vx-*>`), but not checkpoints. */
function pictures(html: string): number {
  const figures = html.match(/<figure\b[^>]*\bclass="vx-diagram[ "]/g)?.length ?? 0
  const widgets = [...html.matchAll(/<vx-([a-z-]+)[\s>]/g)].filter((m) => m[1] !== 'checkpoint')
  return figures + widgets.length
}

/** The scripts on a page, inline or loaded from dist/, that mention Mermaid. */
function mermaidScripts(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\ssrc="([^"]*)"/.exec(m[1]!)?.[1]
    const body =
      src === undefined ? m[2]! : readFileSync(path.join(DIST, src.slice(BASE.length)), 'utf8')
    if (/mermaid/i.test(body)) out.push(src ?? 'inline')
  }
  return out
}
