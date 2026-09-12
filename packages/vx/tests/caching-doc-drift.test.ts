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
