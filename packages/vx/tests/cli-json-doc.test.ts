// The shapes docs/cli.md prints for each verb's `--format json` are its
// schema's (`schemas/<verb>.json`), exactly. cli-json-schemas.test.ts
// holds the output to the schema; this holds the page a reader scripts
// from: a `{ a, b }` the prose shows is an object the schema closes with
// those keys and no others, every object a verb can print at its root is
// shown (`vx why` printed `{ taskId, why, diff, explanation }` for runs
// with no run id, and its section showed only the other shape), and
// `vx info`'s field list is the schema's top level.
//
// A shape is read from the paragraphs that name `--format json` or "in
// JSON", so a config sample in the same section (`{ olderThan, maxSize }`)
// is not one.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const DOC = readFileSync(path.join(ROOT, 'docs', 'cli.md'), 'utf8')
const SECTIONS = {
  cache: 'vx cache prune',
  show: 'vx show',
  info: 'vx info',
  why: 'vx why',
  last: 'vx last',
}

type Schema = Record<string, unknown>
const schemaOf = (verb: string): Schema =>
  JSON.parse(readFileSync(path.join(ROOT, 'schemas', `${verb}.json`), 'utf8')) as Schema

const resolve = (root: Schema, s: Schema): Schema => {
  const ref = s['$ref']
  if (typeof ref !== 'string') return s
  return (root['$defs'] as Record<string, Schema>)[ref.slice('#/$defs/'.length)]!
}

const keySet = (keys: string[]): string => [...keys].sort().join(', ')

/** Every object the schema closes, as its sorted key list. */
function objects(root: Schema): Set<string> {
  const out = new Set<string>()
  const walk = (s: Schema): void => {
    for (const v of (s['oneOf'] ?? []) as Schema[]) walk(resolve(root, v))
    const props = s['properties'] as Record<string, Schema> | undefined
    if (props) {
      out.add(keySet(Object.keys(props)))
      for (const p of Object.values(props)) walk(resolve(root, p))
    }
    if (s['items'] !== undefined) walk(resolve(root, s['items'] as Schema))
  }
  walk(root)
  for (const def of Object.values((root['$defs'] ?? {}) as Record<string, Schema>)) walk(def)
  return out
}

/** The objects a verb can print whole: the root and each `oneOf` variant, arrays aside. */
function roots(root: Schema): string[] {
  const variants = ((root['oneOf'] ?? [root]) as Schema[]).map((v) => resolve(root, v))
  return variants.flatMap((v) => {
    const props = v['properties'] as Record<string, Schema> | undefined
    return props ? [keySet(Object.keys(props))] : []
  })
}

/** A section's paragraphs (fenced lines one by one) that speak of its JSON. */
function jsonText(heading: string): string {
  const start = DOC.indexOf(`\n## \`${heading}\``)
  const end = DOC.indexOf('\n## ', start + 1)
  const section = DOC.slice(start, end)
  const parts = section.split(/\n```[^\n]*\n([\s\S]*?)\n```/)
  const chunks = parts.flatMap((part, i) =>
    i % 2 === 1 ? part.split('\n') : part.split(/\n\s*\n/),
  )
  return chunks
    .filter((c) => c.includes('--format json') || c.includes('in JSON'))
    .join('\n')
    .replace(/\s+/g, ' ')
}

/** `{ a, b: string[], c }` → `a, b, c`, sorted. */
function shapes(text: string): string[] {
  const field = String.raw`[A-Za-z_]\w*(?:: [^,{}]+)?`
  const re = new RegExp(String.raw`\{ (${field}(?:, ${field})*) \}`, 'g')
  return [...text.matchAll(re)].map((m) => keySet(m[1]!.split(', ').map((k) => k.split(':')[0]!)))
}

/** The `--format json` bullet's names outside parentheses: the object's top level. */
function infoFields(): string[] {
  const text = jsonText('vx info')
  const bullet = /- `--format json` prints[\s\S]*?(?= - `|$)/.exec(text)![0]
  let flat = bullet
  for (let prev = ''; prev !== flat;) {
    prev = flat
    flat = flat.replace(/\([^()]*\)/g, '')
  }
  return [...flat.matchAll(/`([A-Za-z]\w*)`/g)].map((m) => m[1]!).sort()
}

describe('docs/cli.md prints each verb JSON shape as its schema closes it', () => {
  it('reads a shape, a type annotation dropped, and only from the JSON paragraphs', () => {
    expect(shapes('emits `{ name, dir, tasks: string[] }` and `{ a }`')).toEqual([
      'dir, name, tasks',
      'a',
    ])
    expect(shapes('`{ ok: false }` and `{a, b}`')).toEqual(['ok'])
    expect(jsonText('vx cache prune')).not.toContain('olderThan')
    expect(jsonText('vx cache prune')).toContain('{ dryRun, evicted')
  })

  for (const [verb, heading] of Object.entries(SECTIONS)) {
    const root = schemaOf(verb)
    const shown = shapes(jsonText(heading))

    it(`${heading}: every shape shown is an object the schema closes`, () => {
      const known = objects(root)
      expect(shown.length).toBeGreaterThan(0)
      expect(shown.filter((s) => !known.has(s))).toEqual([])
    })

    // `vx info`'s root is a field list, not a brace shape: the last row.
    if (verb !== 'info') {
      it(`${heading}: every object it prints at its root is shown`, () => {
        expect(roots(root).filter((r) => !shown.includes(r))).toEqual([])
      })
    }
  }

  it('vx info: the field list is the schema top level', () => {
    const props = Object.keys(schemaOf('info')['properties'] as Schema).sort()
    expect(props.length).toBeGreaterThan(20)
    expect(infoFields()).toEqual(props)
  })
})
