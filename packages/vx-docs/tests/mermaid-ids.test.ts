// A flowchart node whose id is one of mermaid's keywords does not parse:
// the extensibility guide's pipeline read `graph["graph()"]`, and the page
// showed mermaid's error graphic where the diagram belonged (item 697).
// Mermaid's parser needs a DOM, so this reads what the build shipped instead:
// every flowchart on every page, the hand-written ones and the ones the
// Learn widgets generate, and no node id may be a keyword. It holds that
// class, not the whole grammar.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')

// The flowchart grammar's reserved words (mermaid's flow.jison lexer).
const KEYWORDS = new Set([
  'graph',
  'flowchart',
  'subgraph',
  'end',
  'style',
  'linkStyle',
  'classDef',
  'class',
  'click',
  'call',
  'href',
  'direction',
  'default',
  'interpolate',
])

const ARROW = String.raw`(?:-->|---|-\.->|-\.-|==>|===|--[ox]|<-->)`
// An id is a word defined with a label (`id[...]`, `id(...)`, `id{...}`) or
// standing at either end of an arrow.
const ID = new RegExp(
  String.raw`(?:^|[\s;&])([A-Za-z_][\w-]*)\s*(?=[\[({]|${ARROW})|${ARROW}\s*(?:\|[^|]*\|\s*)?([A-Za-z_][\w-]*)`,
  'gm',
)

function unescape(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function flowcharts(): Array<{ page: string; source: string }> {
  const out: Array<{ page: string; source: string }> = []
  for (const e of readdirSync(DIST, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name !== 'index.html') continue
    const file = path.join(e.parentPath, e.name)
    const html = readFileSync(file, 'utf8')
    for (const m of html.matchAll(/<pre class="mermaid"[^>]*>([\s\S]*?)<\/pre>/g)) {
      const source = unescape(m[1]!)
      if (/^\s*(?:flowchart|graph)\b/.test(source)) {
        out.push({ page: path.relative(DIST, path.dirname(file)), source })
      }
    }
  }
  return out
}

function ids(source: string): string[] {
  // The header line (`flowchart LR`) and quoted labels are not ids.
  const body = source.replace(/^\s*(?:flowchart|graph)\b[^\n]*\n/, '').replace(/"[^"]*"/g, '""')
  return [...body.matchAll(ID)].map((m) => (m[1] ?? m[2])!)
}

describe('every flowchart the site ships', () => {
  if (!existsSync(DIST)) throw new Error(`${DIST} is missing: run the site's build task first`)
  const charts = flowcharts()

  it('finds the diagrams and reads their ids', () => {
    expect(charts.length).toBeGreaterThan(10)
    expect(ids('flowchart LR\n  a["x"] --> graph["y"]\n  b -.-> end')).toEqual([
      'a',
      'graph',
      'b',
      'end',
    ])
  })

  it('uses no mermaid keyword as a node id', () => {
    const bad = charts.flatMap(({ page, source }) =>
      ids(source)
        .filter((id) => KEYWORDS.has(id))
        .map((id) => `${page}: ${id}`),
    )
    expect(bad).toEqual([])
  })
})
