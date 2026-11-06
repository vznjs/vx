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
  RANKED,
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
    expect(TOOLS).toEqual(['vx', 'turbo', 'nx', 'vite-task', 'nix', 'moon'])
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
      const want = RANKED.map((t) => [t, c.outcomes[t]?.status ?? 'n/a'])
      if (JSON.stringify(got) !== JSON.stringify(want))
        wrong.push(`${c.id}: ${JSON.stringify(got)}`)
      if (!c.why || !row(c.id).includes('<details class="cfm-why">')) wrong.push(`${c.id}: why`)
      if (agree(c) !== /data-agree(?:=""|\s|>)/.test(row(c.id).slice(0, 200)))
        wrong.push(`${c.id}: agree mark`)
    }
    expect(wrong).toEqual([])
  })

  it('shows each category closed, its summary its row of the score board', () => {
    const wrong: string[] = []
    for (const id of CATEGORIES) {
      const at = html.indexOf(`<details class="cfm-cat" id="${id}"`)
      if (at < 0) {
        wrong.push(`${id}: missing`)
        continue
      }
      const head = html.slice(at, html.indexOf('</summary>', at))
      if (/^<details[^>]*\sopen[\s>=]/.test(head)) wrong.push(`${id}: open`)
      if (!head.includes(`<summary class="cfm-row" data-group="${id}"`))
        wrong.push(`${id}: summary is not its scores`)
      if (head.includes('cfm-cat-about')) wrong.push(`${id}: description in summary`)
    }
    expect(wrong).toEqual([])
  })

  it('says on each category, once opened, what it checks and why it matters', () => {
    const wrong: string[] = []
    for (const id of CATEGORIES) {
      const text = about(id)
      if (!text) {
        wrong.push(`${id}: no description`)
        continue
      }
      if (text.length > 200) wrong.push(`${id}: over 200 chars`)
      const at = html.indexOf(`<details class="cfm-cat" id="${id}"`)
      const body = html.slice(html.indexOf('</summary>', at), html.indexOf('<table', at))
      if (!body.includes(`<p class="cfm-cat-about">${inline(text)}</p>`))
        wrong.push(`${id}: not shown`)
    }
    expect(wrong).toEqual([])
  })

  it('lists the tools by cases passed, most first', () => {
    const passed = (t: string) => RESULTS.scores[t]?.['all']?.pass ?? 0
    expect([...RANKED].sort()).toEqual([...TOOLS].sort())
    for (let i = 1; i < RANKED.length; i++)
      expect(passed(RANKED[i - 1]!)).toBeGreaterThanOrEqual(passed(RANKED[i]!))
    const all = html.slice(
      html.indexOf('data-group="all"'),
      html.indexOf('<details', html.indexOf('data-group="all"')),
    )
    const order = [...all.matchAll(/class="cfm-cell" data-tool="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(RANKED)
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

  it('scores each tool in every group: passed of what it supports, a bar of what it supports, and the counts', () => {
    const groups = ['all', ...CATEGORIES]
    const wrong: string[] = []
    for (const g of groups) {
      const start = html.indexOf(`data-group="${g}"`)
      const tr = html.slice(start, html.indexOf(g === 'all' ? '<details' : '</summary>', start))
      for (const t of TOOLS) {
        const s = RESULTS.scores[t]?.[g]
        const at = tr.indexOf(`<span class="cfm-cell" data-tool="${t}"`)
        const next = tr.indexOf('<span class="cfm-cell"', at + 1)
        const td = at < 0 ? '' : tr.slice(at, next < 0 ? undefined : next)
        const of = s ? `${s.pass} of ${s.of}` : '–'
        if (
          !td.includes(`>${percent(s)}<`) ||
          !td.includes(`>${of}<`) ||
          !td.includes(`>${s?.can} supported<`) ||
          td.includes('supports')
        )
          wrong.push(`${g} ${t}: ${td}`)
      }
    }
    expect(wrong).toEqual([])
    expect(percent({ pass: 0, can: 0, of: 0 })).toBe('–')
    expect(percent({ pass: 0, can: 0, of: 11 })).toBe('–')
    expect(supports({ pass: 0, can: 10, of: 11 })).toBe('90%')
  })

  it('prints 100% only when every supported case passed', () => {
    expect(percent({ pass: 859, can: 860, of: 860 })).toBe('99%')
    expect(percent({ pass: 860, can: 860, of: 860 })).toBe('100%')
    expect(percent({ pass: 1, can: 200, of: 200 })).toBe('0%')
    expect(percent({ pass: 1, can: 1, of: 11 })).toBe('100%')
    expect(percent({ pass: 1, can: 2, of: 11 })).toBe('50%')
  })

  it('names each tool’s version, where the cases come from and the method', () => {
    for (const v of Object.values(RESULTS.tools)) expect(html).toContain(v)
    expect(html).toContain('https://github.com/vznjs/vx/blob/main/private/vx-conformance/README.md')
    expect(unescape(html)).toContain('parsing every test in vx, Turbo, Nx, Vite Task, Nix and moon')
    expect(html).not.toContain('id="coverage"')
  })
})
