// The conformance page (src/pages/conformance/) against the suite's results
// (src/data/conformance.json): the built pages show every case with each
// tool's outcome, a failing cell's detail, and each tool's score in every
// group, so a page that drops or misreads a row fails here. A category's
// cases are on its own page, which the conformance page loads on opening.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  about,
  agree,
  CATEGORIES,
  inline,
  issues,
  note,
  percent,
  RESULTS,
  supports,
  RANKED,
  TOOLS,
  toolName,
  toolShort,
} from '../src/conformance/data.ts'

const DIST = path.resolve(import.meta.dir, '../dist')
const html = readFileSync(path.join(DIST, 'conformance/index.html'), 'utf8')
/** Every category's page, one after another. */
const pages = CATEGORIES.map((id) =>
  readFileSync(path.join(DIST, `conformance/${id}/index.html`), 'utf8'),
).join('\n')

const unescape = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

// Each case's rows, read in one pass: looking each of 2,000 cases up in
// the 2 MB page took the suite past bun's 5 s default (2026-11-22).
const ROWS = new Map<string, { at: number; rows: string[] }>()
for (const m of pages.matchAll(/data-case="([^"]+)"/g)) {
  const entry = ROWS.get(m[1]!) ?? { at: m.index, rows: [] }
  entry.rows.push(pages.slice(m.index, pages.indexOf('</tr>', m.index)))
  ROWS.set(m[1]!, entry)
}

/** A case's row: its `<tr>` to the next. */
function row(id: string): string {
  return ROWS.get(id)?.rows[0] ?? ''
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
      if (ROWS.get(c.id)?.rows.length !== 1) {
        wrong.push(`${c.id}: not shown once`)
        continue
      }
      const section = pages.lastIndexOf('<details class="cfm-cat" id="', ROWS.get(c.id)!.at)
      if (!pages.startsWith(`<details class="cfm-cat" id="${c.category}"`, section))
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

  it('makes every case a link by its short ref, opened by the page’s script', () => {
    const wrong: string[] = []
    for (const c of RESULTS.cases) {
      if (!/^[a-z0-9]{6}$/.test(c.ref)) wrong.push(`${c.id}: ref ${c.ref}`)
      const r = row(c.id)
      if (!pages.includes(`<tr id="${c.ref}" data-case="${c.id}"`)) wrong.push(`${c.id}: no anchor`)
      if (!r.includes(`<a href="#${c.ref}">${c.ref}</a>`)) wrong.push(`${c.id}: no link`)
    }
    expect(wrong).toEqual([])
    expect(new Set(RESULTS.cases.map((c) => c.ref)).size).toBe(RESULTS.cases.length)
    // A category is closed, so the script opens the one a link points into,
    // found by the case's ref.
    expect(html).toContain('hashchange')
    expect(html).toContain('details.cfm-cat')
    const refs = JSON.parse(
      unescape(html.match(/<script type="application\/json" id="cfm-refs">([^<]*)<\/script>/)![1]!),
    ) as Record<string, string>
    expect(refs).toEqual(Object.fromEntries(RESULTS.cases.map((c) => [c.ref, c.category])))
  })

  it('loads a category’s cases from its own page, so the page stays small', () => {
    const wrong: string[] = []
    for (const id of CATEGORIES) {
      const at = html.indexOf(`<details class="cfm-cat" id="${id}"`)
      const body = html.slice(at, html.indexOf('</details>', at))
      if (!body.includes(`<p class="cfm-more" data-cat="${id}"><a href="${id}/">`))
        wrong.push(`${id}: no link to its page`)
    }
    expect(wrong).toEqual([])
    expect(html).not.toContain('data-case=')
    expect(html).toMatch(/querySelector\(.table\.cfm-cases.\)/)
    expect(html.length).toBeLessThan(300_000)
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

  it('opens each N/A cell onto the feature the tool does not have', () => {
    const wrong: string[] = []
    let na = 0
    for (const c of RESULTS.cases) {
      for (const [t, status, inner] of cells(row(c.id))) {
        if (status !== 'n/a') continue
        na++
        if (!c.outcomes[t]?.detail) wrong.push(`${c.id} ${t}: no reason in the data`)
        else if (!inner.includes('<details>') || !unescape(inner).includes(note(c.outcomes[t]!)))
          wrong.push(`${c.id} ${t}: no reason on the page`)
      }
    }
    expect(wrong).toEqual([])
    expect(na).toBeGreaterThan(0)
  })

  it('scores each tool in every group: passed of every case, a bar of passes and issues, and the counts', () => {
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
          !td.includes(`>${issues(s)}<`) ||
          td.includes('supports')
        )
          wrong.push(`${g} ${t}: ${td}`)
      }
    }
    expect(wrong).toEqual([])
    expect(percent({ pass: 0, can: 0, of: 0 })).toBe('–')
    expect(percent({ pass: 0, can: 0, of: 11 })).toBe('0%')
    expect(supports({ pass: 0, can: 10, of: 11 })).toBe('90%')
    expect(issues({ pass: 656, can: 957, of: 1023 })).toBe('301 issues')
    expect(issues({ pass: 0, can: 1, of: 2 })).toBe('1 issue')
  })

  it('prints 100% only when every case passed', () => {
    expect(percent({ pass: 859, can: 860, of: 860 })).toBe('99%')
    expect(percent({ pass: 860, can: 860, of: 860 })).toBe('100%')
    expect(percent({ pass: 1, can: 200, of: 200 })).toBe('0%')
    // An N/A case is not a pass: 992 of 993 is 99%.
    expect(percent({ pass: 992, can: 992, of: 993 })).toBe('99%')
    expect(percent({ pass: 992, can: 993, of: 993 })).toBe('99%')
    expect(percent({ pass: 1, can: 1, of: 11 })).toBe('9%')
    // (29 / 100) * 100 is 28.999…: an exact share must not lose a point.
    expect(percent({ pass: 29, can: 100, of: 100 })).toBe('29%')
    expect(supports({ pass: 0, can: 29, of: 100 })).toBe('29%')
  })

  it('says what each mark means: a fail is an issue, N/A is neither a pass nor an issue', () => {
    const legend = unescape(
      html.slice(
        html.indexOf('class="cfm-legend"'),
        html.indexOf('</ul>', html.indexOf('class="cfm-legend"')),
      ),
    )
    expect(legend).toContain('data-status="pass"')
    expect(legend).toMatch(
      /data-status="fail"[\s\S]*Fail: an issue\.[\s\S]*has the feature but got the case wrong/,
    )
    expect(legend).toMatch(
      /data-status="n\/a"[\s\S]*does not have the feature at all\. Not a pass, and not\s+an issue\./,
    )
  })

  it('names the tool in every score and every mark, for a screen reader and a phone', () => {
    const wrong: string[] = []
    for (const m of html.matchAll(
      /<span class="cfm-cell" data-tool="([^"]+)"[^>]*>([\s\S]*?)<span class="cfm-pct"/g,
    ))
      if (!m[2]!.includes(`>${toolName(m[1]!)}</span>`) || !m[2]!.includes('class="cfm-who"'))
        wrong.push(`score ${m[1]}`)
    for (const c of RESULTS.cases.slice(0, 200))
      for (const [t, status, inner] of cells(row(c.id))) {
        if (!inner.includes('class="cfm-who"')) wrong.push(`${c.id} ${t}: no name`)
        if (!inner.includes(toolName(t))) wrong.push(`${c.id} ${t} ${status}: not named`)
      }
    expect(wrong).toEqual([])
  })

  it('finds a case from one small list of every case, fetched on first use', () => {
    const list = JSON.parse(readFileSync(path.join(DIST, 'conformance/cases.json'), 'utf8')) as [
      string,
      string,
      string,
      string,
      string,
    ][]
    expect(list.length).toBe(RESULTS.cases.length)
    const wrong: string[] = []
    for (const [i, c] of RESULTS.cases.entries()) {
      const want = [
        c.ref,
        c.category,
        c.id,
        c.title,
        RANKED.map(
          (t) => ({ pass: 'p', fail: 'f', 'n/a': 'n' })[c.outcomes[t]?.status ?? 'n/a'],
        ).join(''),
      ]
      if (JSON.stringify(list[i]) !== JSON.stringify(want)) wrong.push(c.id)
    }
    expect(wrong).toEqual([])
    expect(html).toContain('id="cfm-q"')
    expect(html).toMatch(/fetch\(.cases\.json.\)/)
    const names = JSON.parse(
      unescape(
        html.match(/<script type="application\/json" id="cfm-tools">([^<]*)<\/script>/)![1]!,
      ),
    ) as string[]
    expect(names).toEqual(RANKED.map(toolShort))
  })

  it('names each tool’s version, where the cases come from and the method', () => {
    for (const v of Object.values(RESULTS.tools)) expect(html).toContain(v)
    expect(html).toContain('https://github.com/vznjs/vx/blob/main/private/vx-conformance/README.md')
    expect(unescape(html)).toContain('took the tests of vx, Turbo, Nx, Vite Task, Nix and moon')
    expect(html).not.toContain('id="coverage"')
  })
})
