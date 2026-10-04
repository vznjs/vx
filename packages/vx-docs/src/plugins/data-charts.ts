import { visit } from 'unist-util-visit'

// Measurements drawn as bars, not read as digits (owner, 2026-10-04:
// "present data visually not by text and numbers"). One renderer for the
// landing's benchmark and every timing table in the Markdown pages, so the
// two look alike. Static HTML and CSS: no script, no animation (the
// landing's rule, README § The landing page).

export interface Bar {
  name: string
  ms: number
  value: string
  note?: string
  hero?: boolean
}
export interface BarGroup {
  title: string
  bars: Bar[]
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const NUM = String.raw`(\d{1,3}(?:[ ,  ]\d{3})+|\d+)(?:\.(\d+))?`
const num = (int: string, frac = ''): number => Number(`${int.replace(/\D/g, '')}.${frac || '0'}`)
const MIN_SEC = new RegExp(String.raw`^${NUM}\s?m(?:in)?\s+${NUM}\s?s\b`)
const MIN = new RegExp(String.raw`^${NUM}\s?(?:m|min)(?![a-z])`)
const PLAIN = new RegExp(String.raw`^${NUM}(?:\s?[–-]\s?${NUM})?\s?(ms|s)(?![a-z])`)

/** A duration as the docs write it ("476 ms", "1.17s", "3m 47s", "1 min 35 s", "380–450 ms"), in ms; null when the text does not open with one. */
export function parseDuration(text: string): number | null {
  const t = text.trim()
  let m = MIN_SEC.exec(t)
  if (m) return num(m[1]!, m[2]) * 60_000 + num(m[3]!, m[4]) * 1000
  m = MIN.exec(t)
  if (m) return num(m[1]!, m[2]) * 60_000
  m = PLAIN.exec(t)
  if (!m) return null
  // A range reads as its middle.
  const v = m[3] === undefined ? num(m[1]!, m[2]) : (num(m[1]!, m[2]) + num(m[3], m[4])) / 2
  return m[5] === 's' ? v * 1000 : v
}

/** "10.43 s (vx 1% faster)" → ["10.43 s", "vx 1% faster"]. */
function splitNote(text: string): [string, string | undefined] {
  const at = text.indexOf(' (')
  if (at === -1 || !text.endsWith(')')) return [text.trim(), undefined]
  return [text.slice(0, at).trim(), text.slice(at + 2, -1)]
}

export function renderBars(groups: readonly BarGroup[], extraClass = ''): string {
  const figures = groups.map((g) => {
    const max = Math.max(...g.bars.map((b) => b.ms))
    const rows = g.bars.map((b) => {
      const pct = max > 0 ? Math.round((b.ms / max) * 1000) / 10 : 0
      const note = b.note ? `<span class="vx-bar-note">${escapeHtml(b.note)}</span>` : ''
      return (
        `<div class="vx-bar${b.hero ? ' vx-bar-lead' : ''}" style="--w:${pct}%">` +
        `<span class="vx-bar-name">${escapeHtml(b.name)}</span>` +
        `<span class="vx-bar-value">${escapeHtml(b.value)}${note}</span>` +
        `<span class="vx-bar-track"><span class="vx-bar-fill"></span></span></div>`
      )
    })
    return `<figure class="vx-bars"><figcaption>${escapeHtml(g.title)}</figcaption>${rows.join('')}</figure>`
  })
  return `<div class="vx-charts${extraClass ? ` ${extraClass}` : ''}">${figures.join('')}</div>`
}

// ---- Markdown tables → bars ----

interface MdNode {
  type: string
  name?: string
  value?: string
  children?: MdNode[]
}

// "(+0:09)" parses as a text directive named "09" (Starlight's
// remark-directive); it is the text it was written as.
const textOf = (n: MdNode): string =>
  n.type === 'text' || n.type === 'inlineCode'
    ? (n.value ?? '')
    : (n.type === 'textDirective' ? `:${n.name ?? ''}` : '') +
      (n.children ?? []).map(textOf).join('')
const RUNNER = /^(?:vx|turbo|turborepo|nx)\b/i
const isVx = (name: string): boolean => /^vx\b/i.test(name)
// An italic row label is context ("_Baseline_ (theoretical best)"), not a measurement.
const isContext = (row: MdNode): boolean => row.children?.[0]?.children?.[0]?.type === 'emphasis'
const isBlank = (text: string): boolean => /^(?:—|-|)$/.test(text.trim())

/**
 * The bar groups a table's numbers make, or none when it holds no timings.
 * Runners down the side: one group per timed column, a bar per runner.
 * Runners across the top: one group per row. Otherwise one group per timed
 * column, a bar per row. When no runner is named, every bar is vx's own.
 */
export function groupsForTable(header: readonly string[], rows: readonly string[][]): BarGroup[] {
  const runnerRows = rows.some((r) => RUNNER.test(r[0] ?? ''))
  const runnerCols = !runnerRows && header.slice(1).filter((h) => RUNNER.test(h)).length >= 2
  const anyRunner = runnerRows || runnerCols
  const group = (
    title: string,
    cells: ReadonlyArray<readonly [string, string]>,
  ): BarGroup | null => {
    const bars: Bar[] = []
    for (const [name, text] of cells) {
      if (isBlank(text)) continue
      const ms = parseDuration(text)
      if (ms === null) return null
      const [value, note] = splitNote(text)
      bars.push({ name, ms, value, ...(note ? { note } : {}), hero: !anyRunner || isVx(name) })
    }
    return bars.length >= 2 ? { title, bars } : null
  }
  const out: BarGroup[] = []
  if (runnerCols) {
    for (const r of rows) {
      const g = group(
        r[0] ?? '',
        header.slice(1).map((h, i) => [h, r[i + 1] ?? ''] as const),
      )
      if (g) out.push(g)
    }
  } else {
    for (let c = 1; c < header.length; c++) {
      const g = group(
        header[c] ?? '',
        rows.map((r) => [r[0] ?? '', r[c] ?? ''] as const),
      )
      if (g) out.push(g)
    }
  }
  return out
}

/** Draw every timing table as bars, the table itself kept one click away. */
export default function remarkDataCharts() {
  return (tree: MdNode) => {
    visit(
      tree as never,
      'table',
      (node: MdNode, index: number | undefined, parent: MdNode | undefined) => {
        // A table quoted in a blockquote is sample output (a job summary), not a measurement.
        if (!parent?.children || index === undefined || parent.type === 'blockquote') return
        const [head, ...body] = node.children ?? []
        if (!head) return
        const header = (head.children ?? []).map((c) => textOf(c).trim())
        const rows = body
          .filter((r) => !isContext(r))
          .map((r) => (r.children ?? []).map((c) => textOf(c).trim()))
        const groups = groupsForTable(header, rows)
        if (groups.length === 0) return
        parent.children.splice(
          index,
          1,
          { type: 'html', value: renderBars(groups) },
          { type: 'html', value: '<details class="vx-chart-table"><summary>The table</summary>' },
          node,
          { type: 'html', value: '</details>' },
        )
        return index + 4
      },
    )
  }
}
