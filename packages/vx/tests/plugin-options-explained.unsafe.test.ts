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

const NOT_YET = new Set<string>([
  'vx-cache-server: authorize',
  'vx-cache-server: blobs',
  'vx-cache-server: limits',
  'vx-cache: retries',
  'vx-cache: timeoutMs',
  'vx-cache: uploadTimeoutMs',
  'vx-ci: cacheScope',
  'vx-ci: summaryFile',
  'vx-ci: title',
  'vx-devtools: allow',
  'vx-devtools: audience',
  'vx-devtools: fetchJson',
  'vx-devtools: now',
  'vx-devtools: readAccess',
  'vx-dte-server: allow',
  'vx-dte-server: audience',
  'vx-dte-server: fetchJson',
  'vx-dte-server: graceMs',
  'vx-dte-server: heartbeatMs',
  'vx-dte-server: hostname',
  'vx-dte-server: now',
  'vx-dte-server: port',
  'vx-dte-server: runClaims',
  'vx-dte-server: sockets',
  'vx-dte-server: upgrade',
  'vx-dte-server: verify',
  'vx-dte: env',
  'vx-dte: image',
  'vx-dte: tags',
  'vx-dte: workflow',
  'vx-history-server: authorize',
  'vx-history-server: now',
  'vx-history-server: store',
  'vx-history-server: timingDays',
  'vx-history: assume',
  'vx-history: file',
  'vx-history: headers',
  'vx-history: issuer',
  'vx-history: memory',
  'vx-history: repository',
  'vx-history: reservations',
  'vx-history: resources',
  'vx-history: retries',
  'vx-history: timeoutMs',
  'vx-history: url',
  'vx-history: window',
  'vx-lockfile: scope',
  'vx-migrate: audience',
  'vx-migrate: executors',
  'vx-migrate: graph',
  'vx-migrate: oidc',
  'vx-migrate: params',
  'vx-migrate: preflight',
  'vx-migrate: retries',
  'vx-migrate: revokeUrl',
  'vx-migrate: root',
  'vx-migrate: scope',
  'vx-migrate: signatureKey',
  'vx-migrate: teamId',
  'vx-migrate: teamSlug',
  'vx-migrate: timeoutMs',
  'vx-migrate: token',
  'vx-migrate: tokenUrl',
  'vx-migrate: uploadTimeoutMs',
  'vx-migrate: url',
  'vx-reapi: onWarn',
  'vx-reapi: tlsCaPem',
  'vx-reapi: tlsClientCertPem',
  'vx-reapi: tlsClientKeyPem',
  'vx-reapi: toolName',
  'vx-reapi: toolVersion',
])

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
}

function sections(page: string): Section[] {
  const out: Section[] = []
  let open: Array<[depth: number, section: Section]> = []
  let fence = false
  for (const line of page.split('\n')) {
    if (line.startsWith('```')) fence = !fence
    if (fence || line.startsWith('```')) continue
    const h = /^(#+) (.*)/.exec(line)
    if (h) {
      const depth = h[1]!.length
      const names = [...h[2]!.matchAll(/`(?:[\w.]+\.)?(\w+)\([^`]*\)`/g)].map((m) => m[1]!)
      if (/\bOpenTelemetry\b/.test(h[2]!)) names.push('otel')
      const section = { heading: h[2]!, names, rows: new Set<string>() }
      open = open.filter(([d]) => d < depth)
      open.push([depth, section])
      out.push(section)
      continue
    }
    const row = /^\|\s*`(\w+)`\s*\|\s*([^|]*)\|/.exec(line)
    if (row && /[A-Za-z]/.test(row[2]!)) for (const [, s] of open) s.rows.add(row[1]!)
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
  for (const s of sections(page))
    for (const name of s.names)
      for (const pkg of owners.get(name) ?? []) {
        if ((owners.get(name)?.length ?? 0) > 1 && !s.heading.includes(pkg)) continue
        for (const field of s.rows) explained.add(`${pkg}: ${field}`)
      }
  const all: string[] = []
  for (const [pkg, record] of records)
    for (const f of optionFields(record)) all.push(`${pkg}: ${f}`)
  return { explained, all }
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
