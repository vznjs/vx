// Every environment variable a first-party plugin reads is named in that
// package's README. contract-plugin-env.unsafe.test.ts records the reads
// from source (`tests/contract/plugin-env.txt`), so a rename is a reviewed
// diff; this holds the other half: a variable a plugin honours that no
// README names is configuration nobody was told about (vx-migrate read
// eleven, among them `TURBO_CONCURRENCY` and `NX_PARALLEL`, with no word).
//
// A README may name a family once: `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`
// covers the TRACES, METRICS and LOGS reads. A templated read (`*` in the
// record: `OTEL_EXPORTER_OTLP_${suffix}`) is covered by that placeholder
// or by a member the README names (`OTEL_EXPORTER_OTLP_CERTIFICATE`).
//
// `.unsafe`: it reads other packages, which a sandboxed task cannot.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const RECORD = path.join(import.meta.dir, 'contract', 'plugin-env.txt')

/** Each variable-shaped word, `<PLACEHOLDER>` segments included. */
function named(readme: string): string[] {
  return readme.match(/[A-Z][A-Z0-9]*(?:_(?:[A-Z0-9]+|<[A-Z]+>))+/g) ?? []
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A recorded read (`*` for a template's placeholder) against one README word. */
function covers(word: string, read: string): boolean {
  const family = word
    .split(/<[A-Z]+>/)
    .map(escape)
    .join('(?:[A-Z0-9]+|\\*)')
  if (new RegExp(`^${family}$`).test(read)) return true
  if (!read.includes('*') || word.includes('<')) return false
  const template = read.split('*').map(escape).join('[A-Z0-9_]+')
  return new RegExp(`^${template}$`).test(word)
}

function documented(readme: string, read: string): boolean {
  return named(readme).some((word) => covers(word, read))
}

describe('every plugin env read is named in its README', () => {
  const lines = readFileSync(RECORD, 'utf8').trim().split('\n')

  it('reads the record', () => {
    expect(lines.length).toBeGreaterThan(40)
  })

  it('a placeholder or a member covers a family or a template; a neighbour never does', () => {
    const readme = '`OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` and `TURBO_API`'
    expect(documented(readme, 'OTEL_EXPORTER_OTLP_LOGS_HEADERS')).toBe(true)
    expect(documented(readme, 'OTEL_EXPORTER_OTLP_*_HEADERS')).toBe(true)
    expect(documented(readme, 'OTEL_EXPORTER_OTLP_HEADERS')).toBe(false)
    expect(documented(readme, 'OTEL_EXPORTER_OTLP_LOGS_TIMEOUT')).toBe(false)
    expect(documented(readme, 'TURBO_API')).toBe(true)
    expect(documented(readme, 'TURBO_API_KEY')).toBe(false)
    expect(documented('`OTEL_EXPORTER_OTLP_LOGS_HEADERS`', 'OTEL_EXPORTER_OTLP_*_HEADERS')).toBe(
      true,
    )
    expect(documented('`OTEL_EXPORTER_OTLP_PROTOCOL`', 'OTEL_EXPORTER_OTLP_*_PROTOCOL')).toBe(false)
    expect(documented('`OTEL_EXPORTER_OTLP_CERTIFICATE`', 'OTEL_EXPORTER_OTLP_*')).toBe(true)
  })

  it('names none that its README leaves out', () => {
    const readmes = new Map<string, string>()
    const missing: string[] = []
    for (const line of lines) {
      const [pkg, read] = line.split(' ') as [string, string]
      const dir = pkg.replace(/^@vzn\//, '')
      let readme = readmes.get(dir)
      if (readme === undefined) {
        readme = readFileSync(path.join(PACKAGES, dir, 'README.md'), 'utf8')
        readmes.set(dir, readme)
      }
      if (!documented(readme, read)) missing.push(line)
    }
    expect(missing).toEqual([])
  })
})
