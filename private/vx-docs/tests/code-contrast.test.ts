// Every coloured token in a built code block is readable in both themes.
// Expressive Code lifts a theme's own token colours to its minimum contrast,
// but an ` ```ansi ` block's colours are vx's own 24-bit escapes, painted
// as written: vx's pink and blue names (#f472b6, #60a5fa) sat at 2.4:1 on
// the light theme's code background. Each token's `--0` (dark) and `--1`
// (light) colour is held against that theme's code background, read from
// the site's theme (src/styles/theme.css), so a palette change re-checks.
//
// Dimmed text (an ANSI `2m`, a colour with alpha) is held to 3:1, WCAG's
// floor for large text and UI parts: it is meant to recede, not vanish.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const DIST = path.join(SITE, 'dist')
const THEME = readFileSync(path.join(SITE, 'src/styles/theme.css'), 'utf8')

type Rgb = [number, number, number]

function hex(h: string): { rgb: Rgb; alpha: number } {
  const v = h.replace('#', '')
  const full = v.length === 3 || v.length === 4 ? v.replace(/./g, '$&$&') : v
  const m = (i: number): number => Number.parseInt(full.slice(i, i + 2), 16)
  return { rgb: [m(0), m(2), m(4)], alpha: full.length === 8 ? m(6) / 255 : 1 }
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast of `fg` (alpha blended onto `bg`) against `bg`. */
function contrast(fg: string, bg: string): number {
  const f = hex(fg)
  const b = hex(bg).rgb
  const mixed = f.rgb.map((c, i) => c * f.alpha + b[i]! * (1 - f.alpha)) as Rgb
  const [hi, lo] = [luminance(mixed), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** A custom property's value in one of theme.css's blocks. */
function token(block: RegExp, name: string): string {
  const body = block.exec(THEME)?.[1] ?? ''
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim()
  if (value === undefined) throw new Error(`theme.css sets no ${name} there`)
  return value
}

// Starlight's code background: gray-6 in dark, gray-7 in light; the dark
// gray-6 is a var() onto --vx-surface.
const DARK_BG = token(/^:root \{([\s\S]*?)^\}/m, '--vx-surface')
const LIGHT_BG = token(/^:root\[data-theme='light'\] \{([\s\S]*?)^\}/m, '--sl-color-gray-7')

function pages(): string[] {
  return readdirSync(DIST, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.html') && !f.startsWith('pagefind'))
    .sort()
}

describe('code colours', () => {
  it('reads both themes’ code backgrounds from theme.css', () => {
    expect(DARK_BG).toMatch(/^#[0-9a-f]{6}$/i)
    expect(LIGHT_BG).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('every token in a built code block is readable on its theme', () => {
    const bad = new Set<string>()
    let seen = 0
    for (const page of pages()) {
      const html = readFileSync(path.join(DIST, page), 'utf8')
      for (const m of html.matchAll(/style="(--0:#[0-9a-fA-F]+[^"]*)"/g)) {
        const style = m[1]!
        for (const [variant, bg] of [
          ['0', DARK_BG],
          ['1', LIGHT_BG],
        ] as const) {
          const color = new RegExp(`--${variant}:(#[0-9a-fA-F]+)`).exec(style)?.[1]
          if (color === undefined) continue
          seen++
          const floor = hex(color).alpha < 1 ? 3 : 4.5
          const ratio = contrast(color, bg)
          if (ratio < floor) {
            bad.add(
              `${variant === '0' ? 'dark' : 'light'} ${color} ${ratio.toFixed(2)}:1 (${page})`,
            )
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(1000)
    // One line per colour and theme: the first page that shows it.
    const first = new Map<string, string>()
    for (const b of bad) first.set(b.replace(/ \(.*$/, ''), b)
    expect([...first.values()]).toEqual([])
  })
})
