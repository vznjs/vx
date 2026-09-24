// The Guide's diagram kit (src/components/guide/diagram/) draws at build time:
// what it drew is in the built HTML, read here from the page that renders
// each component (internals/diagrams). And it colours only with the theme's
// tokens, which theme.css defines for both themes, so a diagram reads in
// dark and in light alike.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const KIT = path.join(SITE, 'src/components/guide/diagram')
const THEME = path.join(SITE, 'src/styles/theme.css')

// The tokens a diagram may use (design/site-redo-2026-09.md, R1's contract).
const TOKENS = [
  '--vx-accent',
  '--vx-link',
  '--vx-fg',
  '--vx-muted',
  '--vx-surface',
  '--vx-surface-2',
  '--vx-border',
  '--vx-danger',
  '--vx-ok',
  '--vx-warn',
  '--vx-mono',
]

const html = readFileSync(path.join(SITE, 'dist/internals/diagrams/index.html'), 'utf8')

function figures(): string[] {
  return [...html.matchAll(/<figure class="vx-diagram[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)].map(
    (m) => m[1]!,
  )
}

function texts(svg: string, cls: string): string[] {
  return [
    ...svg.matchAll(new RegExp(`<text class="${cls}(?: [^"]*)?"[^>]*>([^<]*)</text>`, 'g')),
  ].map((m) => m[1]!)
}

describe('the diagram kit, as built', () => {
  const [graph, timeline, boxes] = figures()

  it('draws three figures, each one SVG with a role and a label, and a caption', () => {
    expect(figures()).toHaveLength(3)
    for (const f of figures()) {
      const svgs = [...f.matchAll(/<svg\b([^>]*)>/g)]
      expect(svgs).toHaveLength(1)
      expect(svgs[0]![1]).toContain('role="img"')
      expect(svgs[0]![1]).toMatch(/aria-label="[^"]+"/)
      expect(svgs[0]![1]).toMatch(/viewBox="0 0 \d+ \d+"/)
      expect(f).toMatch(/<figcaption\b[^>]*>[\s\S]*\S[\s\S]*<\/figcaption>/)
      expect(f).not.toContain('<script')
    }
  })

  it('places a TaskGraph’s nodes by wave, one box and one arrow each as given', () => {
    expect(texts(graph!, 'label')).toEqual(['utils#build', 'ui#build', 'api#build', 'app#build'])
    expect(texts(graph!, 'sub')).toEqual(['cache hit'])
    const variants = [...graph!.matchAll(/<g class="vx-box (\w+)/g)].map((m) => m[1])
    expect(variants).toEqual(['accent', 'default', 'muted', 'danger'])
    const ys = [...graph!.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="140"/g)].map((m) =>
      Number(m[1]),
    )
    expect(ys[0]).toBeLessThan(ys[1]!)
    expect(ys[1]).toBe(ys[2]!)
    expect(ys[2]).toBeLessThan(ys[3]!)
    const arrows = [...graph!.matchAll(/<g class="vx-arrow([^"]*)"/g)].map((m) => m[1]!)
    expect(arrows).toHaveLength(4)
    expect(arrows.filter((a) => a.includes('dashed'))).toHaveLength(1)
    expect(graph).toMatch(
      /aria-label="Task graph: utils#build to ui#build; [^"]*api#build to app#build\."/,
    )
  })

  it('draws a Timeline’s bars in their lanes, over an axis of ticks in its unit', () => {
    expect(texts(timeline!, 'name')).toEqual(['worker 1', 'worker 2'])
    expect(texts(timeline!, 'tick')).toEqual(['0s', '1s', '2s', '3s', '4s', '5s', '6s', '7s'])
    const bars = [
      ...timeline!.matchAll(/<g class="bar (\w+)[^"]*"[^>]*><title[^>]*>([^<]*)<\/title>/g),
    ]
    expect(bars.map((m) => [m[1], m[2]])).toEqual([
      ['accent', 'utils#build: 0–2s'],
      ['default', 'ui#build: 2–5s'],
      ['default', 'app#build: 5–7s'],
      ['default', 'api#build: 2–4s'],
      ['muted', 'api#test: 4–5s'],
    ])
  })

  it('draws boxes and arrows into a Diagram where they are placed', () => {
    expect(texts(boxes!, 'label')).toEqual(['utils', 'ui', 'api', 'app'])
    expect([...boxes!.matchAll(/<polygon points="/g)]).toHaveLength(3)
    expect(boxes).toContain('aria-label="A shell loop runs the four builds one after another."')
  })
})

describe("the kit's colours", () => {
  it('are the theme’s tokens, and nothing else', () => {
    const wrong: string[] = []
    for (const f of readdirSync(KIT).filter((f) => f.endsWith('.astro'))) {
      const src = readFileSync(path.join(KIT, f), 'utf8')
      for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!TOKENS.includes(m[1]!)) wrong.push(`${f}: ${m[1]}`)
      }
      for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/g))
        wrong.push(`${f}: ${m[0]}`)
    }
    expect(wrong).toEqual([])
  })

  it('are each defined for the dark default and for the light theme', () => {
    const css = readFileSync(THEME, 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      return css.slice(at, css.indexOf('}', at))
    }
    const dark = block(':root')
    const light = block(":root[data-theme='light']")
    // --vx-mono is a font stack, the same in both themes.
    expect(TOKENS.filter((t) => !dark.includes(`${t}:`))).toEqual([])
    expect(TOKENS.filter((t) => t !== '--vx-mono' && !light.includes(`${t}:`))).toEqual([])
  })
})
