// Every field of a first-party plugin's options types is named in that
// package's README. `refuseUnknownOptions` accepts each one, and 1.0
// freezes it; a field no README names is a knob nobody was told about,
// and three were worse than unnamed: `reapi({ onWarn })` was dropped
// without a word, and `reapi({ tlsClientCertPem })` skipped the pair
// check the file options get (#2535). The fields are read from the API
// record (contract-plugin-api.unsafe.test.ts), every `type …Options`.
//
// Named means in an inline code span (`` `tlsCertificate` ``,
// `` `reapi({ endpoint })` ``) or in a fenced sample.
//
// `.unsafe`: it reads other packages, which a sandboxed task cannot.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const RECORDS = path.join(import.meta.dir, 'contract', 'plugin-api')

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

/** The text a README shows as code: inline spans and fenced samples. */
function codeOf(readme: string): string {
  const fences = [...readme.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]!)
  const prose = readme.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')
  const spans = prose.match(/`[^`\n]+`/g) ?? []
  return [...fences, ...spans].join('\n')
}

const named = (code: string, field: string): boolean => new RegExp(`\\b${field}\\b`).test(code)

describe('every plugin option is named in its README', () => {
  const records = readdirSync(RECORDS).filter((f) => f.endsWith('.txt'))

  it('reads the fields of each options type, and only those', () => {
    const record = [
      '== type FooOptions (src/a.ts)',
      'export interface FooOptions {',
      '  readonly scope?: string',
      '  post?: PostFn',
      '}',
      '== type PostFn (src/a.ts)',
      'export interface PostFn {',
      '  url: string',
      '}',
    ].join('\n')
    expect(optionFields(record)).toEqual(['post', 'scope'])
    expect(named(codeOf('takes `reapi({ scope })`'), 'scope')).toBe(true)
    expect(named(codeOf('```ts\nfoo({ post })\n```\n'), 'post')).toBe(true)
    expect(named(codeOf('the scope of it'), 'scope')).toBe(false)
    expect(named(codeOf('`scopes`'), 'scope')).toBe(false)
  })

  it('names none that its README leaves out', () => {
    const missing: string[] = []
    let fields = 0
    for (const file of records) {
      const pkg = file.slice(0, -'.txt'.length)
      const code = codeOf(readFileSync(path.join(PACKAGES, pkg, 'README.md'), 'utf8'))
      for (const field of optionFields(readFileSync(path.join(RECORDS, file), 'utf8'))) {
        fields++
        if (!named(code, field)) missing.push(`${pkg}: ${field}`)
      }
    }
    expect(fields).toBeGreaterThan(40)
    expect(missing).toEqual([])
  })
})
