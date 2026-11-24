// M 2026-11-24: every field of every config is documented with its
// default and an example. A server's config is its environment: each
// variable a server reads (tests/contract/plugin-env.txt) has a row on its
// Docs page (docs/servers/<name>.mdx) whose Default and Example cells say
// something. plugin-env-documented holds the READMEs to naming them.
//
// `.unsafe`: it reads the site, which a sandboxed task cannot.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const RECORD = readFileSync(path.join(import.meta.dir, 'contract', 'plugin-env.txt'), 'utf8')
const PAGES: Record<string, string> = {
  '@vzn/vx-cache-server': 'cache',
  '@vzn/vx-history-server': 'history',
  '@vzn/vx-dte-server': 'dte',
}

/** Each variable a row names first, with whether its Default and Example cells are filled. */
function rows(page: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  let header: string[] | undefined
  for (const line of page.split('\n')) {
    if (!line.startsWith('|')) {
      header = undefined
      continue
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (header === undefined) {
      header = cells.map((c) => c.toLowerCase())
      continue
    }
    const at = (name: string): string => cells[header!.indexOf(name)] ?? ''
    const filled = header.includes('example') && at('default') !== '' && at('example') !== ''
    for (const m of (cells[0] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g))
      out.set(m[1]!, (out.get(m[1]!) ?? false) || filled)
  }
  return out
}

it('reads a row as filled only with a Default and an Example', () => {
  const page = [
    '| Setting | Default | What it does | Example |',
    '| --- | --- | --- | --- |',
    '| `AA` | 1 | a | `2` |',
    '| `BB` | | b | `x` |',
    '| `CC`, `DD` | none | c | |',
  ].join('\n')
  expect([...rows(page)]).toEqual([
    ['AA', true],
    ['BB', false],
    ['CC', false],
    ['DD', false],
  ])
})

it('gives every server variable a default and an example on its page', () => {
  const missing: string[] = []
  for (const [pkg, name] of Object.entries(PAGES)) {
    const page = readFileSync(
      path.join(REPO, 'private/vx-docs/src/content/docs/docs/servers', `${name}.mdx`),
      'utf8',
    )
    const found = rows(page)
    for (const line of RECORD.split('\n')) {
      const [p, v] = line.split(' ')
      if (p === pkg && found.get(v!) !== true) missing.push(`${pkg} ${v}`)
    }
  }
  expect(missing).toEqual([])
})
