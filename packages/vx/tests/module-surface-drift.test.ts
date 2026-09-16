// Each module page's "Public surface" names what the module exports; by
// 2026-09-16 (item 307) four pages named things their module no longer
// exported — a function renamed away, three declarations moved to
// task-hash.ts, two internal helpers, a type owned by another module. The
// index (modules/README.md) maps each page to its source files; every name
// a surface block declares must be exported there, or — for a bullet
// naming a method — be a member the module defines.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')
const DOCS = path.join(pkg, 'docs', 'modules')

/** modules/README.md rows: a page's row plus the rows under it with an empty first cell. */
function sourcesByPage(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string | undefined
  for (const line of readFileSync(path.join(DOCS, 'README.md'), 'utf8').split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split('|')
    const page = /\[`([a-z-]+\.md)`\]/.exec(cells[1] ?? '')?.[1]
    if (page !== undefined) current = page
    else if ((cells[1] ?? '').trim() !== '') continue
    if (current === undefined) continue
    for (const m of (cells[2] ?? '').matchAll(/`(src\/[A-Za-z0-9_./{},-]+\.ts)`/g)) {
      const ref = m[1]!
      const group = /^(.*)\{([^}]*)\}(.*)$/.exec(ref)
      const files = group
        ? group[2]!.split(',').map((p) => group[1]! + p.trim() + group[3]!)
        : [ref]
      out.set(current, [...(out.get(current) ?? []), ...files])
    }
  }
  return out
}

describe('every name a module page declares as public surface exists in its module', () => {
  it('ts-block exports and bullet names resolve against the source the index maps', () => {
    const sources = sourcesByPage()
    const missing: string[] = []
    let names = 0
    for (const file of readdirSync(DOCS)
      .filter((f) => f.endsWith('.md'))
      .sort()) {
      const text = readFileSync(path.join(DOCS, file), 'utf8')
      const section = /^## Public surface\n([\s\S]*?)(?=^## )/m.exec(text)?.[1]
      if (section === undefined) continue
      const files = (sources.get(file) ?? []).filter((s) => existsSync(path.join(pkg, s)))
      if (files.length === 0) continue
      const src = files.map((s) => readFileSync(path.join(pkg, s), 'utf8')).join('\n')
      const declared = new Set<string>()
      const members = new Set<string>()
      for (const m of section.matchAll(
        /^export (?:async )?(?:function|interface|type|const|class|enum|let)\s+([A-Za-z_$][\w$]*)/gm,
      )) {
        declared.add(m[1]!)
      }
      for (const m of section.matchAll(/^- `(?!new )([A-Za-z_$][\w$]*)(?![.\w$])/gm))
        members.add(m[1]!)
      for (const name of new Set([...declared, ...members])) {
        names++
        const exported = new RegExp(
          `export (?:async )?(?:function|interface|type|const|class|enum|let)\\s+${name}\\b|export (?:type )?\\{[^}]*\\b${name}\\b`,
        ).test(src)
        const member = members.has(name) && new RegExp(`\\b${name}\\s*[(:]`).test(src)
        if (!exported && !member) missing.push(`${file}: ${name}`)
      }
    }
    expect(names).toBeGreaterThan(200)
    expect(missing).toEqual([])
  })
})
