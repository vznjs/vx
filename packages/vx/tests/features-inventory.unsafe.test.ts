// docs/features.md is the inventory of every user-facing feature (owner,
// 2026-10-08: "do a huge feature list of everything … save the inventory
// and maintain"). It is held to the surfaces the contract snapshots pin:
// every CLI verb, flag and environment variable in contract/cli-surface.json
// and every config key in contract/config-schema.json must be named in a
// code span there. And its links into the site must land: a blog post that
// exists, a feature page the hub builds. Unsafe: it reads vx-docs.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const CORE = path.resolve(import.meta.dir, '..')
const DOCS_SITE = path.resolve(CORE, '../vx-docs')
const md = readFileSync(path.join(CORE, 'docs/features.md'), 'utf8')
const spans = [...md.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
const named = (word: string): boolean => {
  const re = new RegExp(`(^|[^\\w-])${word.replace(/[$.]/g, '\\$&')}($|[^\\w-])`)
  return spans.some((s) => re.test(s))
}

type Surface = { verbs: Record<string, string[]>; env: string[] }
type Schema = Record<string, { levels?: Record<string, string[]> }>
const surface = JSON.parse(
  readFileSync(path.join(CORE, 'tests/contract/cli-surface.json'), 'utf8'),
) as Surface
const schema = JSON.parse(
  readFileSync(path.join(CORE, 'tests/contract/config-schema.json'), 'utf8'),
) as Schema

describe('docs/features.md names every surface', () => {
  it('every CLI verb, as `vx <verb>`', () => {
    const missing = Object.keys(surface.verbs).filter((v) => !named(`vx ${v}`))
    expect(missing).toEqual([])
  })

  it('every flag', () => {
    const flags = new Set(Object.values(surface.verbs).flat())
    flags.delete('--help')
    expect([...flags].filter((f) => !named(f)).sort()).toEqual([])
  })

  it('every environment variable', () => {
    expect(surface.env.filter((e) => !named(e))).toEqual([])
  })

  it('every config key', () => {
    const keys = new Set<string>()
    for (const { levels } of Object.values(schema)) {
      for (const list of Object.values(levels ?? {})) for (const k of list) keys.add(k)
    }
    expect(keys.size).toBeGreaterThan(40)
    expect([...keys].filter((k) => !named(k)).sort()).toEqual([])
  })

  it('a word missing from the file is caught', () => {
    expect(named('--no-such-flag')).toBe(false)
    expect(named('--affected')).toBe(true)
  })
})

describe('docs/features.md links land', () => {
  const links = [...md.matchAll(/\]\(https:\/\/vznjs\.github\.io\/vx\/([^)#]*)\)/g)].map(
    (m) => m[1]!,
  )

  it('every post link names a blog post', () => {
    const posts = links.filter((l) => l.startsWith('blog/')).map((l) => l.slice(5, -1))
    expect(posts.length).toBeGreaterThan(20)
    const dir = path.join(DOCS_SITE, 'src/content/docs/blog')
    expect(posts.filter((p) => !existsSync(path.join(dir, `${p}.md`)))).toEqual([])
  })

  it('every feature link names a page the hub builds', () => {
    const slugs = new Set(
      ['features.ts', 'more.ts'].flatMap((f) =>
        [
          ...readFileSync(path.join(DOCS_SITE, 'src/features', f), 'utf8').matchAll(
            /slug: '([^']+)'/g,
          ),
        ].map((m) => m[1]!),
      ),
    )
    const pages = links
      .filter((l) => /^features\/.+\/$/.test(l))
      .map((l) => l.slice('features/'.length, -1))
    expect(pages.length).toBeGreaterThan(30)
    expect(pages.filter((p) => !slugs.has(p))).toEqual([])
  })
})
