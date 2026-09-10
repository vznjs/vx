// docs/caching.md enumerates the workspace-fingerprint files by hand and
// names what an edit invalidates. Both drifted once (the invalidation
// table sent `package.json`'s `workspaces` field to the fingerprint,
// which has never hashed it — parity doc L4), so both are pinned to the
// list the code reads, the way schema-doc-drift pins the env allowlist.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
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
