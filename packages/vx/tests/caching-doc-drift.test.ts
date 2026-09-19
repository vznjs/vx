// docs/caching.md enumerates the workspace-fingerprint files by hand and
// names what an edit invalidates. Both drifted once (the invalidation
// table sent `package.json`'s `workspaces` field to the fingerprint,
// which has never hashed it — parity doc L4), so both are pinned to the
// list the code reads, the way schema-doc-drift pins the env allowlist.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CACHE_VERSION, SCHEMA_VERSION } from '../src/cache/index.js'
import { WORKSPACE_FINGERPRINT_FILES } from '../src/workspace/index.js'

const doc = readFileSync(path.join(import.meta.dir, '..', 'docs', 'caching.md'), 'utf8')

function paragraphStarting(marker: string): string {
  const at = doc.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const end = doc.indexOf('\n\n', at)
  return doc.slice(at, end === -1 ? undefined : end)
}

describe('docs/caching.md against the fingerprint the code computes', () => {
  it('the workspace-fingerprint step lists exactly WORKSPACE_FINGERPRINT_FILES', () => {
    const step = paragraphStarting('**Workspace fingerprint**')
    // The enumeration is the sentence after the module link's `):`; the
    // rest of the step explains it and may name other files.
    const from = step.indexOf('):')
    expect(from).toBeGreaterThan(-1)
    const sentence = step.slice(from, step.indexOf('. ', from))
    const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
    expect([...new Set(listed)].sort()).toEqual([...WORKSPACE_FINGERPRINT_FILES].sort())
  })

  it('the invalidation table sends only fingerprint files to step 3', () => {
    const rows = doc
      .split('\n')
      .filter((line) => line.startsWith('| Edit ') && /\|\s*step 3\s*\|/.test(line))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const named = [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
      expect(named.length).toBeGreaterThan(0)
      for (const name of named) expect(WORKSPACE_FINGERPRINT_FILES).toContain(name)
    }
  })
})

// The two version constants are quoted as "currently" in three places a
// reader trusts. The module doc still said the index schema was v25 a
// morning after the v26 bump (2026-09-12); each copy is pinned to the
// constant now. CLAUDE.md quotes them too, but a core test may read only
// its own package, so that copy stays a rule ("verify in source before
// quoting"), not a pin.
describe('the docs quote the current CACHE_VERSION and SCHEMA_VERSION', () => {
  const moduleDoc = readFileSync(
    path.join(import.meta.dir, '..', 'docs', 'modules', 'cache.md'),
    'utf8',
  )

  it('caching.md names the current key-derivation sentinel', () => {
    expect(doc).toContain(`(currently \`'${CACHE_VERSION}'\`, in \`src/cache/cache.ts\`)`)
  })

  it('caching.md heads its schema block with the current SCHEMA_VERSION', () => {
    expect(doc).toContain(`-- src/cache/cache.ts schema (SCHEMA_VERSION = '${SCHEMA_VERSION}')`)
  })

  it('modules/cache.md quotes both constants as they are', () => {
    expect(moduleDoc).toContain(
      `\`CACHE_VERSION\` is currently \`'${CACHE_VERSION}'\`; \`SCHEMA_VERSION\` is\n\`'${SCHEMA_VERSION}'\`.`,
    )
  })
})

/** `CREATE TABLE [IF NOT EXISTS] <name> (` blocks → name → column names. */
function tables(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+) \(([\s\S]*?)\n\s*\);/g)) {
    const columns = m[2]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+\s+(TEXT|INTEGER)/.test(line))
      .map((line) => line.split(/\s+/)[0]!)
    out.set(m[1]!, columns)
  }
  return out
}

describe('caching.md § SQLite tables follows the schema cache.ts creates', () => {
  // The block documented five of ten tables until 2026-09-16 (item 298):
  // nothing read it against the source.
  it('documents every table with exactly its columns', () => {
    const source = tables(
      readFileSync(path.join(import.meta.dir, '..', 'src', 'cache', 'cache.ts'), 'utf8'),
    )
    const block = /```sql\n([\s\S]*?)```/.exec(doc)
    expect(block).not.toBeNull()
    const documented = tables(block![1]!)
    expect(source.size).toBeGreaterThan(5)
    expect([...documented.keys()].sort()).toEqual([...source.keys()].sort())
    for (const [name, columns] of source) expect(documented.get(name)).toEqual(columns)
  })
})

// The numbered list under § Cache key derivation says it describes the parts
// "in order", and the composition is a SEED CHAIN — swap two parts and the
// digest changes. Its steps 11 and 12 were inverted against the fold: the
// code folds `plugin:` between `upstream:` and `inputs:`, while the doc put
// the input files first and the plugin material last (item 385, 2026-09-19).
// Anyone re-deriving a key from this page — a plugin author checking their
// material lands, a refactor — would have produced a different one.
describe('caching.md lists the key parts in the order key() folds them', () => {
  it('each numbered step is the next labelled fold in cache.ts', () => {
    const src = readFileSync(path.join(import.meta.dir, '..', 'src', 'cache', 'cache.ts'), 'utf8')
    const body = src.slice(
      src.indexOf('let h = xxh3(CACHE_VERSION)'),
      src.indexOf('return h.toString(16)'),
    )
    expect(body.length).toBeGreaterThan(500)
    // Every labelled fold, in source order. A part folded per-item (the
    // `${n}\0${v}` pairs) carries no label of its own — the count line above
    // it does, and that is the one the doc enumerates.
    const labels = [...body.matchAll(/h = xxh3\(`([a-z-]+):/g)].map((m) => m[1]!)
    expect(labels).toEqual([
      'task',
      'workspace',
      'pkg',
      'config',
      'forward-args',
      'env-values',
      'runtime-values',
      'ws-runtime-values',
      'upstream',
      'plugin',
      'inputs',
    ])
    // Step 1 is CACHE_VERSION (unlabelled); steps 2..12 are the labels above.
    const expected: Record<string, RegExp> = {
      task: /\*\*`taskId`\*\*/,
      workspace: /\*\*Workspace fingerprint\*\*/,
      pkg: /\*\*Project `package\.json` hash\*\*/,
      config: /\*\*Task config hash\*\*/,
      'forward-args': /\*\*`forwardArgs`\*\*/,
      'env-values': /\*\*`cache\.inputs\.env` resolved values\*\*/,
      'runtime-values': /\*\*`cache\.inputs\.runtime` resolved output\*\*/,
      'ws-runtime-values': /\*\*`cache\.inputs\.workspaceRuntime` resolved output\*\*/,
      upstream: /\*\*Filtered upstream task cache hashes\*\*/,
      plugin: /\*\*Plugin key material\*\*/,
      inputs: /\*\*Input files' content hashes\*\*/,
    }
    const section = doc.slice(
      doc.indexOf('## Cache key derivation'),
      doc.indexOf('## Cache lookup'),
    )
    const steps = [...section.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({
      n: Number(m[1]!),
      text: m[2]!,
    }))
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(steps[0]!.text).toMatch(/\*\*`CACHE_VERSION`\*\*/)
    for (const [i, label] of labels.entries()) {
      const step = steps[i + 1]!
      expect({ label, step: step.n, matches: expected[label]!.test(step.text) }).toEqual({
        label,
        step: i + 2,
        matches: true,
      })
    }
  })
})
