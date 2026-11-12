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
import { sections, sourcesBySection } from './helpers/module-page.js'

const pkg = path.resolve(import.meta.dir, '..')
const DOCS = path.join(pkg, 'docs', 'modules')

/** Each `## ` section of every module page, with the source files the index links to it. */
function sectionsWithSources(): Array<{ page: string; text: string; files: string[] }> {
  const out: Array<{ page: string; text: string; files: string[] }> = []
  const bySection = sourcesBySection()
  for (const page of readdirSync(DOCS)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()) {
    for (const [slug, text] of sections(page)) {
      out.push({ page: `${page}#${slug}`, text, files: bySection.get(`${page}#${slug}`) ?? [] })
    }
  }
  return out
}

describe('every name a module page declares as public surface exists in its module', () => {
  it('ts-block exports and bullet names resolve against the source the index maps', () => {
    const missing: string[] = []
    let names = 0
    for (const { page: file, text, files: linked } of sectionsWithSources()) {
      const section = /^### Public surface\n([\s\S]*?)(?=^### |$(?![\s\S]))/m.exec(text)?.[1]
      if (section === undefined) continue
      const files = linked.filter((s) => existsSync(path.join(pkg, s)))
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

// The same law in the direction nothing held. The surface block promised
// "exported types + functions consumed by other modules" and only the
// forward half was checked, so an export could ship and never reach its
// page: telemetry.md named four things and omitted `TelemetrySink` and
// `TelemetryContext`, the two types a telemetry plugin implements;
// cache.md omitted `CACHE_VERSION` and `SCHEMA_VERSION`, the constants
// CLAUDE.md's Live invariants quote. 38 names across 11 pages
// (item 392, 2026-09-19).
//
// "Consumed by another module" is the convention's own wording, so it is
// the test: an import (or a re-export) of the name, in a file whose
// module directory is not one the page owns. An export used only inside
// its module, or only by tests, is an internal helper and stays out —
// `modules/README.md` says so in the same breath.
describe('every export another module imports is on its page', () => {
  it('no module-crossing name is missing from its Public surface block', () => {
    const srcDir = path.join(pkg, 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) files.push(p)
      }
    }
    walk(srcDir)
    const rel = (abs: string): string => path.relative(pkg, abs).split(path.sep).join('/')
    // `src/cache/x.ts` → `cache`; `src/index.ts` → `<root>`, its own module.
    const moduleOf = (r: string): string => (r.split('/').length > 2 ? r.split('/')[1]! : '<root>')

    // Which files import or re-export each name, and from which module: two
    // modules may export one name, and only an import from the owner counts.
    const importers = new Map<string, { file: string; from: string }[]>()
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8')
      for (const m of text.matchAll(
        /^(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/gms,
      )) {
        if (!m[2]!.startsWith('.')) continue
        const from = moduleOf(rel(path.resolve(path.dirname(abs), m[2]!)))
        for (const part of m[1]!.split(',')) {
          const name = part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]!
            .trim()
          if (name === '') continue
          importers.set(name, [...(importers.get(name) ?? []), { file: rel(abs), from }])
        }
      }
    }

    const undocumented: string[] = []
    let checked = 0
    for (const { page, text, files } of sectionsWithSources()) {
      const section = /^### Public surface\n([\s\S]*?)(?=^### |$(?![\s\S]))/m.exec(text)?.[1]
      if (section === undefined) continue
      const owned = files.filter((s) => existsSync(path.join(pkg, s)))
      if (owned.length === 0) continue
      const ownerModules = new Set(owned.map(moduleOf))
      for (const src of owned) {
        const body = readFileSync(path.join(pkg, src), 'utf8')
        for (const m of body.matchAll(
          /^export (?:async )?(?:function|interface|type|const|class|enum|let)\s+([A-Za-z_$][\w$]*)/gm,
        )) {
          const name = m[1]!
          const crossing = (importers.get(name) ?? [])
            .filter((i) => ownerModules.has(i.from) && !ownerModules.has(moduleOf(i.file)))
            .map((i) => i.file)
          if (crossing.length === 0) continue
          checked += 1
          if (!new RegExp(`\\b${name}\\b`).test(section)) {
            undocumented.push(`${page}: ${name} (imported by ${crossing[0]})`)
          }
        }
      }
    }
    // A floor, so an empty result cannot come from a selector that found
    // nothing to check — the way the first draft of this probe did.
    expect(checked).toBeGreaterThan(150)
    expect(undocumented).toEqual([])
  })
})
