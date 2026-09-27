// schema.md said `sandbox.ignore` takes the whole `allow` vocabulary, "so a
// noisy probe is silenced with the grant that would have permitted it". The
// validator accepts every grant name there but `pty` and `gitConfig`, while
// `resolveSandboxConfig` carries only four of them into the report filter:
// a violation line is sorted into a read, a write, a system-info probe or
// a network reach, and `ignore.unixSockets` (say) loads and matches
// nothing. The page now names which names act; this holds its two lists to
// the resolver and to the validator's accepted set, both ways.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSandboxConfig } from '../src/exec/sandbox-runtime.js'

const DOC = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
const RECORD = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'config-schema.json'), 'utf8'),
) as { project: { fields: Record<string, Record<string, string[]>> } }

/** The names the validator lets through under `ignore` (some value of each passes). */
function accepted(): string[] {
  const prefix = 'tasks.*.exec.sandbox.ignore.'
  return Object.entries(RECORD.project.fields)
    .filter(([k, out]) => k.startsWith(prefix) && (out['ok'] ?? []).some((p) => p !== '<absent>'))
    .map(([k]) => k.slice(prefix.length))
    .sort()
}

/** The paragraph that says which names act. */
function paragraph(): string {
  const at = DOC.indexOf('`ignore` takes')
  expect(at).toBeGreaterThan(-1)
  return DOC.slice(at, DOC.indexOf('\n\n', at))
}

describe('schema.md names the sandbox.ignore fields that act', () => {
  it('the four that act are the ones the resolver keeps', () => {
    const all = Object.fromEntries(accepted().map((k) => [k, k === 'localBinding' ? [1] : ['x']]))
    const resolved = resolveSandboxConfig({ ignore: all } as never, os.tmpdir())
    const acting = Object.keys(resolved.ignore ?? {}).sort()
    const named = [...paragraph().matchAll(/`ignore\.(\w+)`/g)].map((m) => m[1]!).sort()
    expect(named).toEqual(acting)
  })

  it('the rest load and are named as matching nothing', () => {
    const all = Object.fromEntries(accepted().map((k) => [k, k === 'localBinding' ? [1] : ['x']]))
    const resolved = resolveSandboxConfig({ ignore: all } as never, os.tmpdir())
    const inert = accepted().filter((k) => !(k in (resolved.ignore ?? {})))
    const text = paragraph()
    const sentence = text.slice(text.indexOf('leave anything out'), text.indexOf('match nothing'))
    const named = codeSpans(sentence).filter((s) => !s.startsWith('ignore'))
    expect(named.sort()).toEqual(inert)
  })
})

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
}
