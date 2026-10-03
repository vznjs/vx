// `readInSource` (helpers/env-reads.ts) is the set env-doc-drift holds
// cli.md's variables to and contract-cli-surface records, both ways. It
// finds a read by its spelling: `process.env.X`, `process.env['X']` or a
// named constant. A read through a helper (`envInt('VX_X')`) is none of
// those, and plugin-env's reader missed exactly that (H-50). So every
// quoted `'VX_*'` literal in core's source must name a variable the reader
// found: a new helper read fails here instead of passing every doc law.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { readInSource } from './helpers/env-reads.js'

const SRC = path.resolve(import.meta.dir, '..', 'src')

function literals(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) for (const [k, v] of literals(p)) out.set(k, v)
    else if (e.name.endsWith('.ts'))
      for (const m of readFileSync(p, 'utf8').matchAll(/'(VX_[A-Z0-9_]+)'/g))
        out.set(m[1]!, path.relative(SRC, p))
  }
  return out
}

it("every quoted 'VX_*' name in core's source is a read the reader finds", () => {
  const reads = readInSource()
  const quoted = literals(SRC)
  expect(quoted.size).toBeGreaterThan(5)
  const unread = [...quoted].filter(([name]) => !reads.has(name)).map(([n, f]) => `${f}: ${n}`)
  expect(unread).toEqual([])
})
