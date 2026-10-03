// The telemetry records are a 1.0 contract (TELEMETRY_SCHEMA_VERSION):
// package-api.txt freezes their shapes and contract-versioning-doc holds
// the kinds. This holds the reference a sink author reads,
// docs/modules/telemetry.md § Records: each record interface reprinted
// with the source's fields and optionality, and each streaming kind's row
// naming its fields, both ways. A field the source sends that the page
// leaves out is data nobody knows to read; one the page names that the
// source dropped is a sink reading undefined.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = readFileSync(
  path.join(import.meta.dir, '..', 'src', 'orchestrator', 'telemetry.ts'),
  'utf8',
)
const DOC = readFileSync(
  path.join(import.meta.dir, '..', 'docs', 'modules', 'telemetry.md'),
  'utf8',
)
const RECORDS = DOC.slice(DOC.indexOf('## Records'), DOC.indexOf('## Invariants'))

const INTERFACES = ['RunContextRecord', 'TaskTelemetry', 'RunSummaryRecord'] as const

/** `name?` per field line of an interface body, comments dropped. */
function fieldsOf(body: string): string[] {
  const bare = body.replace(/\/\*\*[\s\S]*?\*\//g, '')
  return [...bare.matchAll(/^\s+(?:readonly )?(\w+)(\??):/gm)].map((m) => m[1]! + m[2]!)
}

function declared(text: string, prefix: string, name: string): string[] | undefined {
  const m = new RegExp(`^${prefix}interface ${name} \\{\\n([\\s\\S]*?)^\\}`, 'm').exec(text)
  return m === null ? undefined : fieldsOf(m[1]!)
}

/** Each union member of `TelemetryRecord`: its kind, and its fields beside `v` and `kind`. */
function sourceKinds(): Record<string, string[]> {
  const union = /^export type TelemetryRecord =\n([\s\S]*?)\n\n/m.exec(SRC)![1]!
  const out: Record<string, string[]> = {}
  for (const member of union.split(/^ {2}\| /m).slice(1)) {
    const kind = /kind: '([^']+)'/.exec(member)![1]!
    const fields = [...member.replace(/\/\*\*[\s\S]*?\*\//g, '').matchAll(/(\w+)\??: /g)]
      .map((m) => m[1]!)
      .filter((f) => f !== 'v' && f !== 'kind')
    if (/& TaskTelemetry/.test(member)) fields.push('TaskTelemetry')
    out[kind] = fields.sort()
  }
  return out
}

/** The table's rows: kind → the code spans of its Fields cell. */
function docKinds(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const m of RECORDS.matchAll(/^\| `([a-z]+\.[a-z]+)` +\| (.*)\|$/gm))
    out[m[1]!] = [...m[2]!.matchAll(/`(\w+)`/g)].map((f) => f[1]!).sort()
  return out
}

describe('telemetry.md § Records is the source, both ways', () => {
  it('reads interfaces and the kind table', () => {
    expect(fieldsOf('  a: x // c\n  readonly b?: y\n')).toEqual(['a', 'b?'])
    expect(Object.keys(sourceKinds()).sort()).toEqual([
      'run.end',
      'run.start',
      'task.end',
      'task.log',
      'task.start',
    ])
  })

  it('reprints each record interface with its fields and optionality', () => {
    const drift: Record<string, unknown> = {}
    for (const name of INTERFACES) {
      const src = declared(SRC, 'export ', name)!
      const doc = declared(RECORDS, '', name)
      if (doc === undefined || doc.join() !== src.join()) drift[name] = { src, doc }
    }
    expect(drift).toEqual({})
  })

  it("names each kind's fields in its row", () => {
    expect(docKinds()).toEqual(sourceKinds())
  })
})
