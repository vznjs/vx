// Every exported VALUE — a function, a const, a class, an enum — is named
// by some other code file: an import, a re-export, a call from a test. One
// only its own file uses reads as API and is not; one nothing uses is dead
// code with a comment that may claim what the code no longer does
// (`encodePathList` in @vzn/vx-otel promised output paths as JSON while the
// attribute carried only `deferred`, item 611). Items 611 and 613 swept the
// repo by hand, two dead among them; this is the sweep as a law. Types are
// not in it: an interface in an exported signature is the module page's
// surface (`module-surface-drift.test.ts`) and the schema doc's
// (`schema-doc-drift.test.ts`) whether or not another file names it.
// Unsafe: it reads every package.
//
// Out of scope: `index.ts` façades (the public API, pinned by the boundary
// tests), `bin.ts` entrypoints, and the config files a framework reads by
// name (`content.config.ts`, `vx.config.ts`, `astro.config.mjs`).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

const CODE = /\.(?:ts|mts|cts|js|mjs|cjs|astro)$/
const SKIP =
  /(?:^|\/)(?:index\.ts|bin\.ts|content\.config\.ts|vx\.config\.ts|vx\.workspace\.ts|astro\.config\.mjs)$/
const DECLARATION =
  /^export (?:async )?(?:function\*?|const|let|class|abstract class|enum) ([A-Za-z_$][\w$]*)/gm
const IDENT = /[A-Za-z_$][\w$]*/g

function trackedCode(): string[] {
  const ls = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repo })
  return ls.stdout
    .toString()
    .split('\0')
    .filter((f) => CODE.test(f) && !f.includes('node_modules/'))
}

describe('every exported value is used by another file', () => {
  const files = trackedCode()
  const text = new Map(files.map((f) => [f, readFileSync(path.join(repo, f), 'utf8')]))
  const idents = new Map<string, Set<string>>()
  for (const [f, s] of text) idents.set(f, new Set(s.match(IDENT) ?? []))

  it('scans the whole repo — hundreds of files, every package', () => {
    expect(files.length).toBeGreaterThan(400)
    expect(new Set(files.map((f) => f.split('/')[1])).size).toBeGreaterThan(8)
  })

  it('names no value export that only its own file, or nothing, uses', () => {
    const orphans: string[] = []
    for (const [f, s] of text) {
      if (SKIP.test(f)) continue
      for (const m of s.matchAll(DECLARATION)) {
        const name = m[1]!
        let used = false
        for (const [g, ids] of idents) {
          if (g !== f && ids.has(name)) {
            used = true
            break
          }
        }
        if (!used) orphans.push(`${f}: ${name}`)
      }
    }
    expect(orphans).toEqual([])
  })
})
