// The conformance page (src/pages/conformance/) against the suite's results
// (src/data/conformance.json): the built page shows every case with each
// tool's outcome, a failing cell's detail, and each tool's score in every
// group, so a page that drops or misreads a row fails here.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  about,
  agree,
  CATEGORIES,
  inline,
  note,
  percent,
  RESULTS,
  supports,
  TOOLS,
} from '../src/conformance/data.ts'

const DIST = path.resolve(import.meta.dir, '../dist')
const html = readFileSync(path.join(DIST, 'conformance/index.html'), 'utf8')

const unescape = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/** A case's row: its `<tr>` to the next. */
function row(id: string): string {
  const start = html.indexOf(`data-case="${id}"`)
  if (start < 0) return ''
  return html.slice(start, html.indexOf('</tr>', start))
}

/** Each tool's cell in a row, as [tool, status, inner HTML]. */
function cells(r: string): [string, string, string][] {
  return [
    ...r.matchAll(/<td data-tool="([^"]+)" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g),
  ].map((m) => [m[1]!, m[2]!, m[3]!])
}

describe('the conformance page', () => {
  it('has the data to hold it to', () => {
    expect(RESULTS.cases.length).toBeGreaterThan(50)
    expect(TOOLS).toEqual(['vx', 'turbo', 'nx', 'vite-task', 'nix'])
    expect(
      RESULTS.cases.some((c) => Object.values(c.outcomes).some((o) => o.status === 'fail')),
    ).toBe(true)
  })

  it('shows every case once, in its category, with each tool’s outcome', () => {
    const wrong: string[] = []
    for (const c of RESULTS.cases) {
      if (html.split(`data-case="${c.id}"`).length !== 2) {
        wrong.push(`${c.id}: not shown once`)
        continue
      }
      const section = html.lastIndexOf(
        '<details class="cfm-cat" id="',
        html.indexOf(`data-case="${c.id}"`),
      )
      if (!html.startsWith(`<details class="cfm-cat" id="${c.category}"`, section))
        wrong.push(`${c.id}: not under ${c.category}`)
      const got = cells(row(c.id)).map(([t, s]) => [t, s])
      const want = TOOLS.map((t) => [t, c.outcomes[t]?.status ?? 'n/a'])
      if (JSON.stringify(got) !== JSON.stringify(want))
        wrong.push(`${c.id}: ${JSON.stringify(got)}`)
      if (!c.why || !row(c.id).includes('<details class="cfm-why">')) wrong.push(`${c.id}: why`)
      if (agree(c) !== /data-agree(?:=""|\s|>)/.test(row(c.id).slice(0, 200)))
        wrong.push(`${c.id}: agree mark`)
    }
    expect(wrong).toEqual([])
  })

  it('shows each category closed, its summary giving every tool’s score', () => {
    const wrong: string[] = []
    for (const id of CATEGORIES) {
      const at = html.indexOf(`<details class="cfm-cat" id="${id}"`)
      if (at < 0) {
        wrong.push(`${id}: missing`)
        continue
      }
      const head = html.slice(at, html.indexOf('</summary>', at))
      if (/^<details[^>]*\sopen[\s>=]/.test(head)) wrong.push(`${id}: open`)
      for (const t of TOOLS)
        if (!head.includes(`>${percent(RESULTS.scores[t]?.[id])}</strong>`))
          wrong.push(`${id}: ${t} score`)
    }
    expect(wrong).toEqual([])
  })

  it('says on each category, closed, what it checks and why it matters', () => {
    const wrong: string[] = []
    for (const id of CATEGORIES) {
      const text = about(id)
      if (!text) {
        wrong.push(`${id}: no description`)
        continue
      }
      if (text.length > 200) wrong.push(`${id}: over 200 chars`)
      const at = html.indexOf(`<details class="cfm-cat" id="${id}"`)
      const head = html.slice(at, html.indexOf('</summary>', at))
      if (!head.includes(`<p class="cfm-cat-about">${inline(text)}</p>`))
        wrong.push(`${id}: not shown`)
    }
    expect(wrong).toEqual([])
  })

  it('opens each failing cell onto its detail', () => {
    const wrong: string[] = []
    let fails = 0
    for (const c of RESULTS.cases) {
      for (const [t, status, inner] of cells(row(c.id))) {
        if (status !== 'fail') continue
        fails++
        if (!inner.includes('<details>')) wrong.push(`${c.id} ${t}: no details`)
        if (!unescape(inner).includes(note(c.outcomes[t]!))) wrong.push(`${c.id} ${t}: no detail`)
      }
    }
    expect(wrong).toEqual([])
    expect(fails).toBeGreaterThan(0)
  })

  it('scores each tool in every group: passed and supported, both of every case', () => {
    const groups = ['all', ...CATEGORIES]
    const wrong: string[] = []
    for (const g of groups) {
      const start = html.indexOf(`<tr data-group="${g}"`)
      const tr = html.slice(start, html.indexOf('</tr>', start))
      for (const t of TOOLS) {
        const s = RESULTS.scores[t]?.[g]
        const td = new RegExp(`<td data-tool="${t}"[^>]*>([\\s\\S]*?)</td>`).exec(tr)?.[1] ?? ''
        const of = s && s.of > 0 ? `${s.pass}/${s.of}` : '–'
        if (
          !td.includes(`>${percent(s)}<`) ||
          !td.includes(`>${of}<`) ||
          !td.includes(`>supports ${supports(s)}<`)
        )
          wrong.push(`${g} ${t}: ${td}`)
      }
    }
    expect(wrong).toEqual([])
    expect(percent({ pass: 0, can: 0, of: 0 })).toBe('–')
    expect(supports({ pass: 0, can: 10, of: 11 })).toBe('90%')
  })

  it('prints 100% only when every case passed', () => {
    expect(percent({ pass: 859, can: 860, of: 860 })).toBe('99%')
    expect(percent({ pass: 860, can: 860, of: 860 })).toBe('100%')
    expect(percent({ pass: 1, can: 200, of: 200 })).toBe('0%')
  })

  it('names each tool’s version, where the cases come from and the method', () => {
    for (const v of Object.values(RESULTS.tools)) expect(html).toContain(v)
    expect(html).toContain('https://github.com/vznjs/vx/blob/main/private/vx-conformance/README.md')
    expect(unescape(html)).toContain('parsing every test in vx, Turbo, Nx and Vite Task')
    expect(html).not.toContain('id="coverage"')
  })
})
