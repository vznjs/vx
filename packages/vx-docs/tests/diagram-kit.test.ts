// The Guide's diagram kit (src/components/guide/diagram/): one component
// draws every picture at build time, from data. What it drew is in the built
// HTML, read here from the page that renders each part (internals/diagrams).
// It colours only with the theme's tokens, which theme.css defines for both
// themes, so a picture reads in dark and in light alike. And every chapter's
// picture keeps its text inside its boxes and its drawing, measured in the
// mono face the stylesheet sets, so no label is cut or overlaps its frame.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  FONT,
  boxSize,
  route,
  textWidth,
  type Picture,
} from '../src/components/guide/diagram/diagram.js'
import * as affected from '../src/components/guide/affected/pictures.js'
import * as caching from '../src/components/guide/caching/pictures.js'
import * as concurrency from '../src/components/guide/concurrency/pictures.js'
import * as dependencies from '../src/components/guide/dependencies/pictures.js'
import * as insideVx from '../src/components/guide/inside-vx/pictures.js'
import * as manyMachines from '../src/components/guide/many-machines/pictures.js'
import * as tasks from '../src/components/guide/tasks/pictures.js'
import * as trust from '../src/components/guide/trust/pictures.js'
import * as tryIt from '../src/components/guide/try-it/pictures.js'
import * as why from '../src/components/guide/why/pictures.js'

const SITE = path.resolve(import.meta.dir, '..')
const KIT = path.join(SITE, 'src/components/guide/diagram')
const GUIDE = path.join(SITE, 'src/components/guide')
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

const CHAPTERS: Record<string, Record<string, unknown>> = {
  why,
  tasks,
  dependencies,
  concurrency,
  caching,
  trust,
  affected,
  'many-machines': manyMachines,
  'inside-vx': insideVx,
  'try-it': tryIt,
}

/** Every picture a chapter's `pictures.ts` exports. */
function chapterPictures(): { at: string; p: Picture }[] {
  return Object.entries(CHAPTERS).flatMap(([slug, mod]) =>
    Object.entries(mod)
      .filter(([, v]) => typeof v === 'object' && v !== null && 'boxes' in v && 'caption' in v)
      .map(([k, v]) => ({ at: `${slug}/${k}`, p: v as Picture })),
  )
}

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
      expect(svgs[0]![1]).toMatch(/viewBox="0 0 \d+ \d+"/)
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

describe("every chapter's pictures", () => {
  const all = chapterPictures()

  it('are found, ten chapters of them', () => {
    expect(new Set(all.map((a) => a.at.split('/')[0])).size).toBe(10)
    expect(all.length).toBeGreaterThanOrEqual(30)
  })

  it('have names unique across the Guide', () => {
    const names = all.map((a) => a.p.name)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })

  it('keep every label inside its box or along its arrow, and everything inside the drawing', () => {
    const wrong: string[] = []
    for (const { at, p } of all) {
      const width = p.width ?? 600
      const height = p.height ?? 260
      for (const b of p.boxes) {
        const { w, h } = boxSize(b)
        if (textWidth(b.label, FONT.label) + 6 > w) wrong.push(`${at} ${b.id}: "${b.label}" > ${w}`)
        if (b.sub !== undefined && textWidth(b.sub, FONT.sub) + 6 > w) {
          wrong.push(`${at} ${b.id}: "${b.sub}" > ${w}`)
        }
        if (b.x < 0 || b.y < 0 || b.x + w > width || b.y + h > height) {
          wrong.push(`${at} ${b.id}: outside ${width}×${height}`)
        }
      }
      for (const n of p.notes ?? []) {
        const tw = textWidth(n.text, FONT.note)
        const left = n.anchor === 'start' ? n.x : n.anchor === 'end' ? n.x - tw : n.x - tw / 2
        if (left < 0 || left + tw > width || n.y - FONT.note < 0 || n.y > height) {
          wrong.push(`${at} note "${n.text}": outside ${width}×${height}`)
        }
      }
      for (const a of p.arrows ?? []) {
        if (a.label === undefined) continue
        const r = route(p, a)
        const tw = textWidth(a.label, FONT.arrow)
        if (r.across ? tw + 12 > r.span : r.lx + tw > width) {
          wrong.push(`${at} ${a.from}→${a.to}: "${a.label}" does not fit its arrow`)
        }
      }
      for (const f of p.frames ?? []) {
        if (f.x < 0 || f.y < 0 || f.x + f.w > width || f.y + f.h > height) {
          wrong.push(`${at} frame ${f.label}: outside ${width}×${height}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('join only boxes that exist', () => {
    const wrong = all.flatMap(({ at, p }) =>
      (p.arrows ?? [])
        .flatMap((a) => [a.from, a.to])
        .filter((id) => !p.boxes.some((b) => b.id === id))
        .map((id) => `${at}: ${id}`),
    )
    expect(wrong).toEqual([])
  })
})

describe("the kit's colours and faces", () => {
  it('are the theme’s tokens, and nothing else, in the kit and every chapter', () => {
    const wrong: string[] = []
    const files = [
      ...readdirSync(KIT).map((f) => path.join(KIT, f)),
      ...Object.keys(CHAPTERS).map((slug) => path.join(GUIDE, slug, 'pictures.ts')),
    ].filter((f) => /\.(astro|css|ts)$/.test(f))
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
