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

describe('docs/optimizations.md cites files that exist and symbols they hold', () => {
  // The catalog's Where column cited execute-task.ts for hashing that moved
  // to task-hash.ts, a cache/remote-cache.ts that does not exist, and
  // layered-cache.ts for globbing it no longer does (2026-09-16, item 310).
  it('every `module/file.ts[:symbol]` resolves under src/', () => {
    const doc = readFileSync(path.join(pkg, 'docs', 'optimizations.md'), 'utf8')
    const missing: string[] = []
    let cited = 0
    for (const m of doc.matchAll(/`([a-z-]+\/[a-z-]+\.ts)(?::([A-Za-z]+))?`/g)) {
      cited++
      const file = path.join(pkg, 'src', m[1]!)
      if (!existsSync(file)) {
        missing.push(m[1]!)
        continue
      }
      if (m[2] !== undefined && !new RegExp(`\\b${m[2]}\\b`).test(readFileSync(file, 'utf8'))) {
        missing.push(`${m[1]}:${m[2]}`)
      }
    }
    expect(cited).toBeGreaterThan(30)
    expect(missing).toEqual([])
    // A bare `file.ts` is ambiguous across modules; the catalog qualifies every citation.
    expect([...doc.matchAll(/(?<![/`\w])`[a-z-]+\.ts(?::[A-Za-z]+)?`/g)].map((m) => m[0])).toEqual(
      [],
    )
  })
})

// README.md's headline warm figure was `79 ms` — the WAVE 2 column of
// benchmarks.md's 100-project row, two waves behind the 74 ms floor that
// why-vx-is-fast.md quotes (item 383, 2026-09-19). A pin asking "is this
// number on benchmarks.md?" would have passed it, because it is: in the
// wrong column. The floor is the LAST column of the row, so that is what
// this reads.
describe('README.md quotes the current warm floor, not a wave on the way', () => {
  it('its 100-project figure is the last column of the warm-run row', () => {
    const bench = readFileSync(path.join(pkg, 'docs', 'benchmarks.md'), 'utf8')
    const row = /^\| 100 +\|(.+)\|[^|]*\|$/m.exec(bench)
    expect(row).not.toBeNull()
    const cells = row![1]!.split('|').map((c) => c.trim())
    expect(cells.length).toBeGreaterThan(4)
    const floor = cells[cells.length - 1]!
    expect(floor).toMatch(/^\d+ ms$/)
    const readme = readFileSync(path.join(pkg, 'docs', 'README.md'), 'utf8')
    const quoted = /100-project workspace completes in \*\*(\d+ ms)\*\*/.exec(readme)
    expect(quoted).not.toBeNull()
    expect({ quoted: quoted![1]!, floor }).toEqual({ quoted: floor, floor })
  })
})

// comparison.md contradicted itself: its "Likely-worth-adding" item 7 records
// `--output-logs hash-only` as SHIPPED (2026-08-25) and its flag map lists
// all four modes, while the "Shipped since this list was first drawn" bullet
// listed three — written before hash-only landed and never revisited
// (item 383, 2026-09-19). The modes are a list run.ts owns.
describe("comparison.md's shipped list names every --output-logs mode", () => {
  it('its bullet is the set run.ts accepts', () => {
    const run = readFileSync(path.join(pkg, 'src', 'cli', 'run.ts'), 'utf8')
    const guard = /if \(([^)]*v !== '[^']+'[^)]*)\) \{/.exec(run)
    expect(guard).not.toBeNull()
    const modes = [...guard![1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
    expect(modes.sort()).toEqual(['errors-only', 'full', 'hash-only', 'none'])
    const doc = readFileSync(path.join(pkg, 'docs', 'comparison.md'), 'utf8')
    const bullet = /^- `--output-logs ([a-z|-]+)`\.$/m.exec(doc)
    expect(bullet).not.toBeNull()
    expect(bullet![1]!.split('|').sort()).toEqual(modes)
  })
})

// Its Shipped list described the config-evaluation purity gate as opting a
// config out on "any `/` outside a comment". The gate refuses a BACKSLASH —
// `stripLiterals` removes literals and comments, and what survives must hold
// no identifier escape, because `\u0070rocess` IS `process` and no deny-list
// can see it. A forward slash is in every path literal and every division, so
// as written the gate excluded almost every config and the evaluation cache
// read as a feature that never applies. modules/config-cache.md had it right
// all along, pinned since item 314 (item 393, 2026-09-19).
describe("comparison.md states the purity gate's three conditions", () => {
  it('the escape character, the one bare import and the closure cap match source', () => {
    const src = readFileSync(path.join(pkg, 'src', 'workspace', 'config-cache.ts'), 'utf8')
    // The three the sentence claims, each read from the module.
    expect(src).toContain("code.includes('\\\\')")
    const cap = /const MAX_CLOSURE_FILES = (\d+)/.exec(src)
    const pure = /const PURE_PACKAGE = '([^']+)'/.exec(src)
    expect(cap).not.toBeNull()
    expect(pure).not.toBeNull()

    const doc = readFileSync(path.join(pkg, 'docs', 'comparison.md'), 'utf8')
    const sentence = /a lexer-backed purity GATE[\s\S]*?opts a config out\./.exec(doc)
    expect(sentence).not.toBeNull()
    const text = sentence![0]!
    expect(text).toContain('BACKSLASH')
    expect(text).toContain(`non-\`${pure![1]}\` bare`)
    expect(text).toContain(`closure past ${cap![1]} files`)
    // The error this pin exists for: a forward slash as the escape claim.
    expect(/any `\/`/.test(text)).toBe(false)
  })
})
