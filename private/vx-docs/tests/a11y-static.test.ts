// Accessibility facts a built page carries in its HTML. The runtime ones
// (contrast, focus, scrolling regions) were checked with axe-core over every
// page at 375 and 1280 px, both themes, on 2026-11-23.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { REGION_NAMES_MARKER } from '../src/plugins/code-region-names.ts'

const DIST = path.join(import.meta.dir, '..', 'dist')

function pages(): [string, string][] {
  return readdirSync(DIST, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f, readFileSync(path.join(DIST, f), 'utf8')])
}

describe('built pages', () => {
  const all = pages()

  it('name each aside landmark once per page', () => {
    const repeats: string[] = []
    for (const [file, html] of all) {
      const labels = [...html.matchAll(/<aside[^>]*\baria-label="([^"]*)"/g)].map((m) => m[1])
      const twice = labels.filter((l, i) => labels.indexOf(l) !== i)
      if (twice.length > 0) repeats.push(`${file}: ${[...new Set(twice)].join(', ')}`)
    }
    expect(repeats).toEqual([])
  })

  it('name every code block that becomes a scrolling region', () => {
    const missing = all
      .filter(([, html]) => html.includes('class="expressive-code"'))
      .filter(([file, html]) => !html.includes(REGION_NAMES_MARKER) && !scriptsCarry(file, html))
      .map(([file]) => file)
    expect(missing).toEqual([])
  })
})

// Expressive Code may ship its modules as an external script.
function scriptsCarry(file: string, html: string): boolean {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].some(([, src]) => {
    const local = src!.replace(/^\/vx\//, '')
    try {
      return readFileSync(path.join(DIST, local), 'utf8').includes(REGION_NAMES_MARKER)
    } catch {
      return false
    }
  })
}
