// The config schema is a 1.0 contract: `tests/contract/config-schema.json`
// records every level the validator accepts and its fields, and
// `config-types-schema.test.ts` holds the TypeScript types to it. This holds
// the reference: docs/schema.md reprints each level's shape, as an
// `interface` block (held to src/config.ts by schema-doc-drift) or an inline
// object type (`cacheRetention?: { olderThan?: string; maxSize?: string }`),
// with exactly the fields the record holds; and every interface it reprints
// is one of those levels. A field the validator takes that no reprint shows
// is a key users cannot find; a reprinted field it refuses is a key they
// write and are refused.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DOC = readFileSync(path.join(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
const RECORD = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'config-schema.json'), 'utf8'),
) as Record<'workspace' | 'project', { levels: Record<string, string[]> }>

const sorted = (fields: Iterable<string>): string => [...new Set(fields)].sort().join(',')

/** Each `interface X { … }` block's fields, by name. */
function interfaces(doc: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of doc.matchAll(/^interface (\w+) \{\n([\s\S]*?)^\}/gm))
    out.set(m[1]!, sorted([...m[2]!.matchAll(/^ {2}(\w+)\??[:(]/gm)].map((f) => f[1]!)))
  return out
}

/** Each inline object type in a ts fence (`{ a?: x; b?: y }`), as its field set. */
function inlineTypes(doc: string): Set<string> {
  const out = new Set<string>()
  for (const fence of doc.matchAll(/^```ts\n([\s\S]*?)^```/gm))
    for (const m of fence[1]!.matchAll(/\??: \{ ([^{}\n]+) \}/g)) {
      const fields = [...m[1]!.matchAll(/(\w+)\?:/g)].map((f) => f[1]!)
      if (fields.length > 0) out.add(sorted(fields))
    }
  return out
}

const LEVELS = Object.entries(RECORD).flatMap(([side, r]) =>
  Object.entries(r.levels).map(([level, fields]) => ({
    level: `${side}:${level || '(root)'}`,
    fields: sorted(fields),
  })),
)

describe('docs/schema.md reprints every config level, and only levels', () => {
  it('reads interface blocks and inline types, and only those', () => {
    const doc =
      '```ts\ninterface A {\n  x?: string // c\n  y(): void\n}\nz?: { p?: string; q?: number }\n```\n'
    expect([...interfaces(doc)]).toEqual([['A', 'x,y']])
    expect([...inlineTypes(doc)]).toEqual(['p,q'])
    expect(LEVELS.length).toBeGreaterThan(12)
  })

  it('every level the record holds is reprinted with exactly its fields', () => {
    const shown = new Set([...interfaces(DOC).values(), ...inlineTypes(DOC)])
    expect(
      LEVELS.filter((l) => !shown.has(l.fields)).map((l) => `${l.level} {${l.fields}}`),
    ).toEqual([])
  })

  it('every reprinted interface is a level the record holds', () => {
    const levels = new Set(LEVELS.map((l) => l.fields))
    const strays = [...interfaces(DOC)].filter(([, fields]) => !levels.has(fields))
    expect(strays.map(([name, fields]) => `${name} {${fields}}`)).toEqual([])
  })
})
