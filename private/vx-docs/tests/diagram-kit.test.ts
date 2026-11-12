// The diagram kit (src/components/guide/diagram/): one component draws
// every picture at build time, from data. What it drew is in the built HTML,
// read here from the page that renders each part (internals/diagrams). It
// colours only with the theme's tokens, which theme.css defines for both
// themes, so a picture reads in dark and in light alike.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const KIT = path.join(SITE, 'src/components/guide/diagram')
const THEME = path.join(SITE, 'src/styles/theme.css')

// The tokens a picture may use (design/site-redo-2026-09.md, R1's contract),
// and the two font stacks: the mono in the drawing, the sans in the caption.
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
]
const FONTS = ['--vx-mono', '--vx-font-body']

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
  const [graph, timeline, frame] = figures()

  it('draws three figures, each one SVG with a role and a label, and a caption', () => {
    expect(figures()).toHaveLength(3)
    for (const f of figures()) {
      const svgs = [...f.matchAll(/<svg\b([^>]*)>/g)]
      expect(svgs).toHaveLength(1)
      expect(svgs[0]![1]).toContain('role="img"')
      expect(svgs[0]![1]).toMatch(/aria-label="[^"]+"/)
      expect(svgs[0]![1]).toMatch(/viewBox="0 \d+ \d+ \d+"/)
      expect(f).toMatch(/<figcaption\b[^>]*>[\s\S]*\S[\s\S]*<\/figcaption>/)
      expect(f).not.toContain('<script')
    }
  })

  it('draws each box with its tone, label and sub line, and each arrow with its head', () => {
    expect(texts(graph!, 'label')).toEqual(['utils#build', 'ui#build', 'api#build', 'app#build'])
    expect(texts(graph!, 'sub')).toEqual(['cache hit'])
    expect([...graph!.matchAll(/<g class="box (\w+)"/g)].map((m) => m[1])).toEqual([
      'accent',
      'default',
      'muted',
      'danger',
    ])
    const arrows = [...graph!.matchAll(/<g class="arrow (\w+)"[^>]*>\s*<path\b([^>]*)>/g)]
    expect(arrows).toHaveLength(4)
    expect(arrows.filter((a) => a[2]!.includes('class="dashed"'))).toHaveLength(1)
    // One marker per tone the arrows use, named for the picture.
    expect([...graph!.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'vx-dg-kit-graph-default',
    ])
    for (const a of arrows) expect(a[2]).toContain('marker-end="url(#vx-dg-kit-graph-default)"')
  })

  it('lays a timeline out as boxes, one row per worker, its name beside it', () => {
    expect(texts(timeline!, 'note muted')).toEqual(['worker 1', 'worker 2'])
    expect(texts(timeline!, 'label')).toEqual(['utils', 'ui', 'app', 'api'])
    const x = (label: string): number =>
      Number(
        new RegExp(
          `<rect x="([\\d.]+)"[^>]*>(?:</rect>)?\\s*<text class="label"[^>]*>${label}<`,
        ).exec(timeline!)![1],
      )
    // api starts when ui does: two workers, side by side.
    expect(x('api')).toBe(x('ui'))
    expect(x('ui')).toBeGreaterThan(x('utils'))
  })

  it('draws frames and notes in their tones', () => {
    expect(frame).toMatch(/<g class="frame link">\s*<rect\b[^>]*rx="12"/)
    expect(texts(frame!, 'note danger')).toEqual(['a note, in the tone it needs'])
  })
})

describe("the kit's colours and faces", () => {
  it('are the theme’s tokens, and nothing else, in the kit and every picture', () => {
    const wrong: string[] = []
    const files = [...readdirSync(KIT).map((f) => path.join(KIT, f))].filter((f) =>
      /\.(astro|css|ts)$/.test(f),
    )
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (![...TOKENS, ...FONTS].includes(m[1]!)) wrong.push(`${path.basename(f)}: ${m[1]}`)
      }
      for (const m of src.matchAll(
        /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(|font-family:(?!\s*var\()/g,
      ))
        wrong.push(`${path.basename(f)}: ${m[0]}`)
    }
    // Positive first: the stylesheet was read.
    expect(readFileSync(path.join(KIT, 'diagram.css'), 'utf8')).toContain('var(--vx-accent)')
    expect(wrong).toEqual([])
  })

  // The widgets take the pictures' look (Next 16 b): the same tokens and
  // faces, and a frame and caption of the same size, so no widget reads as a
  // second hand.
  it('are the only colours and faces of the widgets, framed like a picture', () => {
    const DEMOS = path.join(SITE, 'src/components/demos')
    const files = [path.join(SITE, 'src/components/Demo.astro'), path.join(DEMOS, 'widget.css')]
    const wrong: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (![...TOKENS, ...FONTS].includes(m[1]!)) wrong.push(`${path.basename(f)}: ${m[1]}`)
      }
      for (const m of src.matchAll(
        /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(|font-family:(?!\s*var\()/g,
      ))
        wrong.push(`${path.basename(f)}: ${m[0]}`)
    }
    const widget = readFileSync(path.join(DEMOS, 'widget.css'), 'utf8')
    const kit = readFileSync(path.join(KIT, 'diagram.css'), 'utf8')
    const rule = (css: string, selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    // Positive first: the widgets' stylesheet was read, and Demo loads it.
    expect(widget).toContain('var(--vx-accent)')
    expect(readFileSync(files[0]!, 'utf8')).toContain("import './demos/widget.css'")
    expect(wrong).toEqual([])
    const frame = (css: string, selector: string): string[] =>
      rule(css, selector)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(?:border|border-radius|background|padding|margin):/.test(l))
    expect(frame(widget, '.vx-demo')).toEqual(frame(kit, '.vx-diagram'))
    const caption = (css: string, selector: string): string[] =>
      rule(css, selector)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(?:font-size|line-height|color|text-align):/.test(l))
    expect(caption(widget, '.vx-demo > figcaption')).toEqual(caption(kit, '.vx-diagram figcaption'))
  })

  it('set the landing’s mono in the drawing and the body’s sans in the caption', () => {
    const css = readFileSync(path.join(KIT, 'diagram.css'), 'utf8')
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(rule('.vx-diagram svg')).toContain('font-family: var(--vx-mono);')
    expect(rule('.vx-diagram figcaption')).toContain('font-family: var(--vx-font-body);')
    expect(css.match(/font-family/g)).toHaveLength(2)
  })

  it('are each defined for the dark default and for the light theme', () => {
    const css = readFileSync(THEME, 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      return css.slice(at, css.indexOf('}', at))
    }
    const dark = block(':root')
    const light = block(":root[data-theme='light']")
    expect([...TOKENS, ...FONTS].filter((t) => !dark.includes(`${t}:`))).toEqual([])
    // A font stack is the same in both themes.
    expect(TOKENS.filter((t) => !light.includes(`${t}:`))).toEqual([])
  })
})
