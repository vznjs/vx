// Docs that point at files are only worth trusting while the files exist.
// Two probes found rot after five file splits (STATUS § Improvement loop,
// items 37 and 42): pointers at renamed tests and deleted design docs, and
// a module index that claimed a page per module while a third of `src/`
// had none. Both are laws now.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { headingSlugs, proseLinks } from './helpers/markdown-anchors.js'

const pkg = path.resolve(import.meta.dir, '..')

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

/**
 * Prose that names files: the docs and the module pages. The site guides
 * and CLAUDE.md live outside this project, which a sandboxed shard cannot
 * read (the cross-project law) — `doc-references.unsafe.test.ts` holds
 * them to the same rule.
 */
function proseFiles(): string[] {
  return walk(path.join(pkg, 'docs'), '.md').filter(
    (p) =>
      !p.includes(`${path.sep}design${path.sep}`) &&
      !p.includes(`${path.sep}history${path.sep}`) &&
      !p.endsWith('STATUS.md'),
  )
}

describe('every file path the docs name exists', () => {
  it('src/, tests/ and docs/ paths in prose resolve under packages/vx', () => {
    const missing: string[] = []
    for (const file of proseFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/`((?:src|tests|docs)\/[A-Za-z0-9_./-]+\.(?:ts|md|mjs))`/g)) {
        const ref = m[1]!
        if (!existsSync(path.join(pkg, ref))) missing.push(`${path.relative(pkg, file)}: ${ref}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('docs/modules/README.md indexes every source module', () => {
  it('names each src/**/*.ts (index files aside), itself or in a brace group', () => {
    const readme = readFileSync(path.join(pkg, 'docs', 'modules', 'README.md'), 'utf8')
    const named = new Set<string>()
    for (const m of readme.matchAll(/src\/([A-Za-z0-9_./{},-]+\.ts)/g)) {
      const ref = m[1]!
      const group = /^(.*)\{([^}]*)\}(.*)$/.exec(ref)
      if (group) {
        for (const part of group[2]!.split(',')) named.add(group[1]! + part.trim() + group[3]!)
      } else named.add(ref)
    }
    const unindexed = walk(path.join(pkg, 'src'), '.ts')
      .map((p) => path.relative(path.join(pkg, 'src'), p).split(path.sep).join('/'))
      .filter((rel) => !rel.endsWith('index.ts') && !named.has(rel))
    expect(unindexed).toEqual([])
  })
})

describe('every relative link in the docs resolves', () => {
  it('`](x.md)` names a file, and `](x.md#anchor)` a heading of it by its rendered id', () => {
    const missing: string[] = []
    const slugs = new Map<string, Set<string>>()
    for (const file of proseFiles()) {
      for (const { target, anchor } of proseLinks(readFileSync(file, 'utf8'))) {
        const page = target === '' ? file : path.resolve(path.dirname(file), target)
        const link = `${path.relative(pkg, file)}: ${target}${anchor === undefined ? '' : `#${anchor}`}`
        if (!existsSync(page)) {
          missing.push(link)
          continue
        }
        if (anchor === undefined || !page.endsWith('.md')) continue
        if (!slugs.has(page)) slugs.set(page, headingSlugs(readFileSync(page, 'utf8')))
        if (!slugs.get(page)!.has(anchor)) missing.push(link)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('docs/README.md § Repository layout follows src/', () => {
  it('tabulates exactly the module directories, and states their count', () => {
    const readme = readFileSync(path.join(pkg, 'docs', 'README.md'), 'utf8')
    const rows = [...readme.matchAll(/^\| `([a-z]+)\/`\s+\|/gm)].map((m) => m[1]!).sort()
    const dirs = readdirSync(path.join(pkg, 'src'))
      .filter((name) => statSync(path.join(pkg, 'src', name)).isDirectory())
      .sort()
    expect(rows).toEqual(dirs)
    const WORDS = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ]
    expect(readme).toContain(`Core \`src/\` is **${WORDS[dirs.length]} modules**`)
  })
})
