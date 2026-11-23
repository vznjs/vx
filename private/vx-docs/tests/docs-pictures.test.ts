// The Docs pages draw their pictures at build time (components/docs/
// pictures.ts), not with Mermaid in the browser. Each picture's words fit
// its boxes, and its phone layout fits a phone and says the same thing.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import * as pictures from '../src/components/docs/pictures.js'
import { boxSize, textWidth, type Box } from '../src/components/guide/diagram/diagram.js'

// The phone layout's width (the kit's README).
const NARROW = 360
const DIST = path.resolve(import.meta.dir, '../dist')
const PAGES: Record<string, string> = {
  'docs/caching/': 'cache-key',
  'docs/writing-plugins/': 'plugin-stages',
  'docs/distributed-task-execution/': 'dte-run',
  'docs/tasks/': 'task-graph',
  'docs/remote-cache/': 'remote-cache',
}

const fits = (b: Box): boolean => {
  const { w } = boxSize(b)
  return textWidth(b.label, 15) + 12 <= w && (b.sub === undefined || textWidth(b.sub, 13) + 12 <= w)
}

describe('the Docs pictures', () => {
  const all = Object.values(pictures)

  it('fit every label and sub line in its box, wide and narrow', () => {
    const wrong = all.flatMap((p) =>
      [...p.boxes, ...(p.narrow?.boxes ?? [])]
        .filter((b) => !fits(b))
        .map((b) => `${p.name}: ${b.label}`),
    )
    expect(wrong).toEqual([])
  })

  it('each have a phone layout no wider than a phone, with the same boxes and arrows', () => {
    for (const p of all) {
      const n = p.narrow!
      expect(n.width).toBeLessThanOrEqual(NARROW)
      for (const b of n.boxes) expect(b.x + boxSize(b).w).toBeLessThanOrEqual(n.width)
      const words = (bs: Box[]) => bs.map((b) => `${b.id}:${b.label}:${b.sub}`).sort()
      expect(words(n.boxes)).toEqual(words(p.boxes))
      const arrows = (as: typeof p.arrows) => (as ?? []).map((a) => `${a.from}>${a.to}:${a.label}`)
      expect(arrows(n.arrows).sort()).toEqual(arrows(p.arrows).sort())
    }
  })

  it('are drawn into their pages at build time, with no Mermaid left there', () => {
    for (const [page, name] of Object.entries(PAGES)) {
      const html = readFileSync(path.join(DIST, page, 'index.html'), 'utf8')
      expect(html).toContain(`data-picture="${name}"`)
      expect(html).not.toContain('class="mermaid"')
    }
  })
})
