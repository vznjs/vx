// M 2026-11-23: "Every field from all config should be documented and
// explained". plugin-options-documented.unsafe.test.ts holds each README to
// naming every option; this holds the Docs pages to explaining it, on
// whichever page owns the factory (one fact, one page: `vxCache()` on
// remote-cache, `dte()` on its own page):
// a table row whose first cell is the field in backticks and whose next
// cell says something, under a heading for the package's factory
// (`` ### `vxCache()` ``). OpenTelemetry's options live in the table under
// its own "## OpenTelemetry" section. A row counts anywhere in the
// heading's section, subsections included.
//
// `github()` and `gitlab()` are factories of both vx-ci and vx-dte, so a
// heading naming one counts only for the package it also names (`vx-ci`).
//
// A row also gives its default (a `Default` cell) and an example (an
// `Example` cell, or code in another cell): M asked for both, 2026-11-24.
//
// NOT_YET is the day's to-do (docs redo, 2026-11-24): it may only shrink.
// A field listed here that gains a row, or that no options type has any
// more, fails too, so the list stays true.
//
// `.unsafe`: it reads other packages and the site, which a sandboxed task
// cannot.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const RECORDS = path.join(import.meta.dir, 'contract', 'plugin-api')
const DOCS = path.join(REPO, 'private', 'vx-docs', 'src', 'content', 'docs', 'docs')

/** Every Docs page, each opening at a top heading so no section runs into the next page. */
const pages = (): string =>
  readdirSync(DOCS, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.mdx?$/.test(f))
    .sort()
    .map((f) => `# ${f}\n${readFileSync(path.join(DOCS, f), 'utf8')}`)
    .join('\n')

const NOT_YET = new Set<string>([])

/** The fields of each `== type …Options` block in a record. */
function optionFields(record: string): string[] {
  const fields = new Set<string>()
  let inOptions = false
  for (const line of record.split('\n')) {
    if (line.startsWith('== ')) inOptions = /^== type \w+Options /.test(line)
    else if (inOptions) {
      const m = /^ {2}(?:readonly )?(\w+)\??:/.exec(line)
      if (m) fields.add(m[1]!)
    }
  }
  return [...fields].sort()
}

/** The functions a record exports that take an options type: the factories a heading names. */
function factories(record: string): string[] {
  return [...record.matchAll(/^export function (\w+)\(\w+: \w+Options\b/gm)].map((m) => m[1]!)
}

/** A heading's section: the factories it names, and the field of each table row under it. */
interface Section {
  readonly heading: string
  readonly names: readonly string[]
  readonly rows: Set<string>
  /** The rows that also give a default and an example. */
  readonly complete: Set<string>
}

/**
 * A row gives its default in a non-empty `Default` cell, and an example in
 * a non-empty `Example` cell or as code in another cell than the field's.
 */
function completeRow(header: readonly string[], cells: readonly string[]): boolean {
  const at = (name: string): string | undefined => {
    const i = header.findIndex((h) => h.toLowerCase() === name)
    return i === -1 ? undefined : cells[i]
  }
  const def = at('default')
  if (def === undefined || def === '') return false
  const example = at('example')
  if (example !== undefined) return example !== ''
  return cells.some((c, i) => i > 0 && header[i]?.toLowerCase() !== 'default' && /`[^`]+`/.test(c))
}

function sections(page: string): Section[] {
  const out: Section[] = []
  let open: Array<[depth: number, section: Section]> = []
  let fence = false
  let header: string[] | undefined
  for (const line of page.split('\n')) {
    if (line.startsWith('```')) fence = !fence
    if (fence || line.startsWith('```')) continue
    const cells = line.startsWith('|')
      ? line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
      : undefined
    if (cells === undefined) header = undefined
    else if (header === undefined) header = cells
    const h = /^(#+) (.*)/.exec(line)
    if (h) {
      const depth = h[1]!.length
      const names = [...h[2]!.matchAll(/`(?:[\w.]+\.)?(\w+)\([^`]*\)`/g)].map((m) => m[1]!)
      if (/\bOpenTelemetry\b/.test(h[2]!)) names.push('otel')
      const section = {
        heading: h[2]!,
        names,
        rows: new Set<string>(),
        complete: new Set<string>(),
      }
      open = open.filter(([d]) => d < depth)
      open.push([depth, section])
      out.push(section)
      continue
    }
    const row = /^\|\s*`(\w+)`\s*\|\s*([^|]*)\|/.exec(line)
    if (row && /[A-Za-z]/.test(row[2]!))
      for (const [, s] of open) {
        s.rows.add(row[1]!)
        if (completeRow(header ?? [], cells ?? [])) s.complete.add(row[1]!)
      }
  }
  return out
}

/** Every `pkg: field` the page explains, and every one an options type has. */
function survey(page: string, records: ReadonlyMap<string, string>) {
  const owners = new Map<string, string[]>()
  for (const [pkg, record] of records)
    for (const f of factories(record)) owners.set(f, [...(owners.get(f) ?? []), pkg])
  owners.set('otel', ['vx-otel'])
  const explained = new Set<string>()
  const complete = new Set<string>()
  for (const s of sections(page))
    for (const name of s.names)
      for (const pkg of owners.get(name) ?? []) {
        if ((owners.get(name)?.length ?? 0) > 1 && !s.heading.includes(pkg)) continue
        for (const field of s.rows) explained.add(`${pkg}: ${field}`)
        for (const field of s.complete) complete.add(`${pkg}: ${field}`)
      }
  const all: string[] = []
  for (const [pkg, record] of records)
    for (const f of optionFields(record)) all.push(`${pkg}: ${f}`)
  return { explained, complete, all }
}

describe('every plugin option is explained on a Docs page', () => {
  const records = new Map(
    readdirSync(RECORDS)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => [f.slice(0, -'.txt'.length), readFileSync(path.join(RECORDS, f), 'utf8')]),
  )

  it('reads a row under its factory heading, and only there', () => {
    const fake = new Map([
      [
        'vx-a',
        '== type AOptions (src/a.ts)\nexport interface AOptions {\n  url?: string\n  bare?: string\n}\nexport function a(options: AOptions = {}): VxPlugin',
      ],
      [
        'vx-b',
        'export function github(options: BOptions = {}): X\n== type BOptions (x)\nexport interface BOptions {\n  title?: string\n}',
      ],
      [
        'vx-c',
        'export function github(options: COptions = {}): X\n== type COptions (x)\nexport interface COptions {\n  env?: string\n}',
      ],
    ])
    const page = [
      '## Every plugin option',
      '### `a()`',
      '| Field | What it does |',
      '| --- | --- |',
      '| `url` | Where it sends. |',
      '| `bare` | |',
      '#### More',
      '| `env` | Counted for a(), not vx-c. |',
      '### `github()` in vx-b',
      '| `title` | The heading. |',
      '```md',
      '| `env` | In a sample. |',
      '```',
      '## OpenTelemetry',
      '| `endpoint` | Where spans go. |',
    ].join('\n')
    const { explained, all } = survey(page, fake)
    expect(all.sort()).toEqual(['vx-a: bare', 'vx-a: url', 'vx-b: title', 'vx-c: env'])
    expect([...explained].sort()).toEqual([
      'vx-a: env',
      'vx-a: url',
      'vx-b: title',
      'vx-otel: endpoint',
    ])
  })

  it('explains every field of every options type', () => {
    const { explained, all } = survey(pages(), records)
    expect(all.length).toBeGreaterThan(90)
    expect(all.filter((f) => !explained.has(f) && !NOT_YET.has(f))).toEqual([])
  })

  it('lists in NOT_YET only fields still without a row', () => {
    const { explained, all } = survey(pages(), records)
    expect([...NOT_YET].filter((f) => explained.has(f) || !all.includes(f))).toEqual([])
  })
})

describe('every plugin option gives its default and an example', () => {
  const records = new Map(
    readdirSync(RECORDS)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => [f.slice(0, -'.txt'.length), readFileSync(path.join(RECORDS, f), 'utf8')]),
  )

  it('reads a default cell and an example from a row', () => {
    const h = ['Option', 'What it does', 'Default']
    expect(completeRow(h, ['`url`', 'Where it sends: `https://x`.', '`VX_URL`'])).toBe(true)
    expect(completeRow(h, ['`url`', 'Where it sends.', '`VX_URL`'])).toBe(false)
    expect(completeRow(h, ['`url`', 'Where it sends: `https://x`.', ''])).toBe(false)
    expect(completeRow(['Option', 'What it does'], ['`url`', 'Where: `https://x`.'])).toBe(false)
    const e = ['Field', 'What it does', 'Default', 'Example']
    expect(completeRow(e, ['`max`', 'At once: `2`.', 'none', ''])).toBe(false)
    expect(completeRow(e, ['`max`', 'At once.', 'none', '`max: 4`'])).toBe(true)
  })

  it('gives every field of every options type a default and an example', () => {
    const { complete, all } = survey(pages(), records)
    expect(all.filter((f) => !complete.has(f))).toEqual([])
  })
})
