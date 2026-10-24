// The CLI reference is one source (packages/vx/docs/cli.md) served as one
// page per command (scripts/import-docs.ts, CLI_PAGES). A link from outside
// the site still names an id of the old single page: each one must land on
// the page that holds it now, and the JSON refusal's `docs` link
// (cli/#vx_e_<code>, src/util/errors.ts) must not move at all.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { splitCli } from '../scripts/import-docs.ts'

const DIST = path.resolve(import.meta.dir, '../dist')
const CLI_MD = readFileSync(
  path.resolve(import.meta.dir, '../../../packages/vx/docs/cli.md'),
  'utf8',
)
const { anchors } = splitCli(CLI_MD)

function ids(page: string): Set<string> {
  const html = readFileSync(path.join(DIST, 'cli', page, 'index.html'), 'utf8')
  return new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!))
}

describe('the CLI reference, one page per command', () => {
  it('sends every id of the one-page reference to a built page that has it', () => {
    let fenced = false
    const headings = CLI_MD.split('\n').filter((l) => {
      if (/^\s*(```|~~~)/.test(l)) fenced = !fenced
      return !fenced && /^#{2,6}\s/.test(l)
    })
    expect(anchors.size).toBe(headings.length)
    const lost = [...anchors].filter(([, a]) => {
      if (!existsSync(path.join(DIST, 'cli', a.page, 'index.html'))) return true
      return a.id !== undefined && !ids(a.page).has(a.id)
    })
    expect(lost).toEqual([])
  })

  it('keeps every error code on cli/, where a refusal links it', () => {
    const codes = [...CLI_MD.matchAll(/^#### `(VX_E_\w+)`/gm)].map((m) => m[1]!.toLowerCase())
    expect(codes.length).toBeGreaterThan(10)
    expect(codes.filter((c) => anchors.get(c)?.page !== '')).toEqual([])
    const here = ids('')
    expect(codes.filter((c) => !here.has(c))).toEqual([])
  })

  it('forwards an old #id on cli/ to its page', () => {
    const html = readFileSync(path.join(DIST, 'cli', 'index.html'), 'utf8')
    expect(html).toContain('"vx-why":"why/"')
    expect(html).toContain('location.replace(')
  })
})
