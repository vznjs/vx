// docs/design/versioning-1.0.md § What 1.0 freezes lists what the contract
// holds: every config level and its fields, the plugin hooks, the telemetry
// record kinds. A list a reader trusts has to move with the code, so each
// is held here, both ways, to its source of truth: the config levels to
// the record the validator is held to (contract-config-schema.test.ts),
// the hooks to `PLUGIN_HOOKS`, the telemetry kinds and version to the
// source's `TelemetryRecord` and `TELEMETRY_SCHEMA_VERSION`.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PLUGIN_HOOKS, TELEMETRY_SCHEMA_VERSION } from '../src/index.js'
import { surfaceOf } from './helpers/api-surface.js'

const ROOT = path.resolve(import.meta.dir, '..')
const DOC = readFileSync(path.join(ROOT, 'docs', 'design', 'versioning-1.0.md'), 'utf8')
const RECORD = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'config-schema.json'), 'utf8'),
) as Record<'workspace' | 'project', { levels: Record<string, string[]>; records: string[] }>

/** The section's text, from its heading to the next heading of its rank or above. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`)
  expect({ heading, found: start !== -1 }).toEqual({ heading, found: true })
  const rank = /^#+/.exec(heading)![0]
  const rest = DOC.slice(start + heading.length + 2)
  const end = rest.search(new RegExp(`^#{1,${rank.length}} `, 'm'))
  return end === -1 ? rest : rest.slice(0, end)
}

const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)

/** The doc's `<name>` is the record's `*`. */
const generic = (level: string): string => level.replaceAll('<name>', '*')

/** The level table that follows the line naming `file`, as level → sorted fields. */
function levelTable(text: string, file: string): Record<string, string[]> {
  const at = text.indexOf(`\`${file}\`:`)
  expect({ file, found: at !== -1 }).toEqual({ file, found: true })
  const out: Record<string, string[]> = {}
  const lines = text.slice(at).split('\n').slice(1)
  for (const line of lines.slice(lines.findIndex((l) => l.startsWith('|')))) {
    if (!line.startsWith('|')) break
    const [, level = '', fields = ''] = line.split('|').map((c) => c.trim())
    if (level === 'Level' || /^-+$/.test(level)) continue
    out[level === '(top)' ? '' : generic(codeSpans(level)[0]!)] = codeSpans(fields).sort()
  }
  return out
}

describe('versioning-1.0.md lists what the code freezes', () => {
  const config = section('### Config fields')

  it('every config level and its fields, as the validator accepts them', () => {
    expect(levelTable(config, 'vx.workspace.ts')).toEqual(RECORD.workspace.levels)
    expect(levelTable(config, 'vx.config.ts')).toEqual(RECORD.project.levels)
  })

  it('every level keyed by an author-chosen name', () => {
    const line = config.split('\n').find((l) => l.startsWith('Keyed by name:'))!
    expect(codeSpans(line).map(generic).sort()).toEqual(
      [...RECORD.workspace.records, ...RECORD.project.records].sort(),
    )
  })

  const plugin = section('### The plugin API')

  it('the hooks, in pipeline order', () => {
    const item = plugin.slice(plugin.indexOf('**Hooks**'), plugin.indexOf('A plugin is'))
    expect(codeSpans(item)).toEqual([...PLUGIN_HOOKS])
  })

  it('the telemetry record kinds and their schema version', () => {
    const item = plugin.slice(plugin.indexOf('**Telemetry records**'), plugin.indexOf('**Types.**'))
    expect(item).toContain(`schema version ${TELEMETRY_SCHEMA_VERSION}.`)
    const record = surfaceOf(path.join(ROOT, 'src', 'index.ts'), ROOT).get(
      'type TelemetryRecord (src/orchestrator/telemetry.ts)',
    )!
    const kinds = [...record.join('\n').matchAll(/kind: '([^']+)'/g)].map((m) => m[1]!)
    expect(kinds.length).toBeGreaterThan(0)
    expect(codeSpans(item).filter((s) => s !== 'v')).toEqual(kinds)
  })

  it('the named plugin types are exported', () => {
    const item = plugin.slice(plugin.indexOf('**Types.**'))
    const surface = surfaceOf(path.join(ROOT, 'src', 'index.ts'), ROOT)
    const declared = new Set([...surface.keys()].map((k) => k.split(' ')[1]))
    const named = codeSpans(item)
      .flatMap((s) => s.split(' / '))
      .filter((s) => /^[A-Z]/.test(s))
    expect(named.length).toBeGreaterThan(5)
    expect(named.filter((n) => !declared.has(n))).toEqual([])
  })
})
