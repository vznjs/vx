// The CLI reference (packages/vx/docs/cli.md) and the config reference
// (schema.md) are each one source served as one page per part
// (scripts/import-docs.ts, SPLIT_REFERENCES). A link from outside the site
// still names an id of the old single page: each one must land on the page
// that holds it now, and the JSON refusal's `docs` link
// (cli/#vx_e_<code>, src/util/errors.ts) must not move at all.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { SPLIT_REFERENCES, splitReference } from '../scripts/import-docs.ts'

const DIST = path.resolve(import.meta.dir, '../dist')
const SOURCES = path.resolve(import.meta.dir, '../../../packages/vx/docs')

function ids(file: string): Set<string> {
  const html = readFileSync(file, 'utf8')
  return new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!))
}

for (const { src, base, specs, list } of SPLIT_REFERENCES) {
  const source = readFileSync(path.join(SOURCES, src), 'utf8')
  const { anchors } = splitReference(source, specs, list)
  const built = (page: string) => path.join(DIST, base, page, 'index.html')

  describe(`${src}, one page per part`, () => {
    it('sends every id of the one-page reference to a built page that has it', () => {
      let fenced = false
      const headings = source.split('\n').filter((l) => {
        if (/^\s*(```|~~~)/.test(l)) fenced = !fenced
        return !fenced && /^#{2,6}\s/.test(l)
      })
      expect(anchors.size).toBe(headings.length)
      const lost = [...anchors].filter(([, a]) => {
        if (!existsSync(built(a.page))) return true
        return a.id !== undefined && !ids(built(a.page)).has(a.id)
      })
      expect(lost).toEqual([])
    })

    it('forwards an old #id on its own page to the page that took it', () => {
      const html = readFileSync(built(''), 'utf8')
      const [old, to] = [...anchors].find(([, a]) => a.page !== '')!
      expect(html).toContain(`"${old}":"${to.page}/`)
      expect(html).toContain('location.replace(')
    })
  })
}

describe('the error codes', () => {
  it('stay on cli/, where a refusal links them', () => {
    const cli = SPLIT_REFERENCES.find((r) => r.src === 'cli.md')!
    const source = readFileSync(path.join(SOURCES, cli.src), 'utf8')
    const { anchors } = splitReference(source, cli.specs, cli.list)
    const codes = [...source.matchAll(/^#### `(VX_E_\w+)`/gm)].map((m) => m[1]!.toLowerCase())
    expect(codes.length).toBeGreaterThan(10)
    expect(codes.filter((c) => anchors.get(c)?.page !== '')).toEqual([])
    const here = ids(path.join(DIST, 'cli', 'index.html'))
    expect(codes.filter((c) => !here.has(c))).toEqual([])
  })
})
