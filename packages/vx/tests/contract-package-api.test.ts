// The plugin API and the package's exports are 1.0 contract surfaces
// (docs/design/versioning-1.0.md): `PLUGIN_HOOKS`, `VxPlugin` and its
// contexts, `CacheLayer` / `RemoteCacheLayer`, `TaskExecutor`, the telemetry
// records, and everything else `src/index.ts` exports. The façade snapshot in
// package-boundaries.unsafe.test.ts pins their NAMES; this file pins their
// SHAPES against a committed record, `tests/contract/package-api.txt`.
//
// The record is read from the source (tests/helpers/api-surface.ts): every
// declaration the façade re-exports, followed through imports, with every
// type it names, transitively; comments and blank lines dropped, a function
// cut at its body, a class to its public members. Constants add their
// runtime value, so a constant built by an expression is pinned by what it
// holds.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-package-api.test.ts

import { describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as facade from '../src/index.js'
import { surfaceOf } from './helpers/api-surface.js'

const ROOT = path.resolve(import.meta.dir, '..')
const RECORD = path.join(import.meta.dir, 'contract', 'package-api.txt')

/** What the façade's constants hold. `VERSION` moves with every release and is no shape. */
function values(): string[] {
  return Object.entries(facade)
    .filter(([name, v]) => typeof v !== 'function' && name !== 'VERSION')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, v]) =>
        `${name} = ${JSON.stringify(v instanceof Set ? Array.from(v as Set<unknown>) : v)}`,
    )
}

function current(): string {
  const parts: string[] = []
  for (const [id, text] of surfaceOf(path.join(ROOT, 'src', 'index.ts'), ROOT)) {
    parts.push(`== ${id}`, ...text)
  }
  parts.push('== runtime values', ...values())
  return parts.join('\n') + '\n'
}

describe('the package API contract (versioning-1.0.md)', () => {
  it('the façade names the hooks its plugin type declares', () => {
    // The record holds `PLUGIN_HOOKS` and `VxPlugin` apart; this row holds
    // them together, from the runtime list and the recorded interface.
    const vxPlugin = surfaceOf(path.join(ROOT, 'src', 'index.ts'), ROOT).get(
      'type VxPlugin (src/orchestrator/plugin.ts)',
    )!
    const members = vxPlugin
      .map((l) => /^ {2}(?:readonly )?(\w+)\??[(:]/.exec(l)?.[1])
      .filter((m): m is string => m !== undefined && m !== 'name')
    expect([...members].sort()).toEqual([...facade.PLUGIN_HOOKS].sort())
  })

  it('the façade agrees with tests/contract/package-api.txt', () => {
    const live = current()
    if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
      writeFileSync(RECORD, live)
    }
    // On a failure, the diff below IS the API change: regenerate the record
    // (header) only if the change is meant to ship, and say so in the
    // release notes.
    expect(live).toBe(readFileSync(RECORD, 'utf8'))
  })
})
