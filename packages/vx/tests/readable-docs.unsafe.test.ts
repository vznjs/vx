// The config and CLI references, and every package's README (npm's page
// for it), are read as docs. The references render as the site's /schema/ and /cli/
// pages (private/vx-docs/scripts/import-docs.ts). M, on a phone screenshot
// of `inputs.files` (2026-11-23): "What is this? What human can or will
// read that". So the reference holds the docs' own rules: no paragraph or
// bullet over five phone lines (200 characters, as it renders), and no
// internal id a reader cannot look up.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '../../..')
const README = /^README\.md$/
const MAX = 200
const ID = /\b(?:W?D|X|H|M|A|L|C|B)-\d{1,3}\b|\bitem \d{3,4}\b|\(#\d{3,5}\)/

const rendered = (s: string): string =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()

function problems(name: string, text: string): string[] {
  const out: string[] = []
  let fence: string | undefined
  let unit: string[] = []
  let start = 0
  const flush = () => {
    const t = rendered(unit.join(' '))
    if (t.length > MAX) out.push(`${name}:${start} ${t.length} characters: ${t.slice(0, 60)}…`)
    unit = []
  }
  text.split('\n').forEach((line, i) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (open && open[1] === fence) fence = undefined
      return
    }
    if (open) {
      flush()
      fence = open[1]
      return
    }
    const id = ID.exec(line.replace(/`[^`]*`/g, ' '))
    if (id) out.push(`${name}:${i + 1} internal id "${id[0]}"`)
    if (/^\s*$/.test(line) || /^\s*(#|\||<|>)/.test(line)) return flush()
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      flush()
      start = i + 1
    } else if (unit.length === 0) start = i + 1
    unit.push(line)
  })
  flush()
  return out
}

describe('the references read on a phone', () => {
  it('a long paragraph and an internal id are caught', () => {
    expect(problems('t.md', `${'word '.repeat(50)}\n\n- see D-52\n`)).toEqual([
      't.md:1 249 characters: word word word word word word word word word word word word …',
      't.md:3 internal id "D-52"',
    ])
    expect(problems('t.md', '```\n' + 'x'.repeat(300) + ' D-1\n```\n')).toEqual([])
  })

  const files = [
    'packages/vx/docs/schema.md',
    'packages/vx/docs/cli.md',
    'README.md',
    ...readdirSync(path.join(ROOT, 'packages'))
      .map((p) => `packages/${p}/README.md`)
      .filter((f) => existsSync(path.join(ROOT, f))),
  ]
  it('reads every README', () => {
    expect(files.filter((f) => README.test(path.basename(f))).length).toBeGreaterThan(10)
  })
  for (const file of files) {
    it(`${file} has no long paragraph and no internal id`, () => {
      expect(problems(file, readFileSync(path.join(ROOT, file), 'utf8'))).toEqual([])
    })
  }
})
