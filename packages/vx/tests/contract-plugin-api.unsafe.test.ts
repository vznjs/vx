// Each first-party plugin package's exports are held like core's
// (contract-package-api.test.ts): one record per package,
// `tests/contract/plugin-api/<package>.txt`, read from its `src/index.ts`
// by tests/helpers/api-surface.ts. A change to what a plugin exports is a
// reviewed diff of that record, and scripts/api-break.ts judges it.
//
// `.unsafe`: it reads other packages, which a sandboxed task cannot.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-plugin-api.unsafe.test.ts

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { surfaceOf } from './helpers/api-surface.js'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const RECORDS = path.join(import.meta.dir, 'contract', 'plugin-api')

/** Every workspace package that publishes an entry, core aside. */
function plugins(): string[] {
  return readdirSync(PACKAGES)
    .filter((dir) => {
      const manifest = path.join(PACKAGES, dir, 'package.json')
      if (dir === 'vx' || !existsSync(manifest)) return false
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: unknown }
      return pkg.exports !== undefined
    })
    .sort()
}

function current(dir: string): string {
  const root = path.join(PACKAGES, dir)
  const parts: string[] = []
  for (const [id, text] of surfaceOf(path.join(root, 'src', 'index.ts'), root)) {
    parts.push(`== ${id}`, ...text)
  }
  return parts.join('\n') + '\n'
}

const update = process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true'

describe('the plugin packages API contract (versioning-1.0.md)', () => {
  it('a record exists for each plugin package, and none for another', () => {
    if (update) mkdirSync(RECORDS, { recursive: true })
    const recorded = readdirSync(RECORDS)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -4))
    expect(recorded.sort()).toEqual(update ? recorded.sort() : plugins())
  })

  for (const dir of plugins()) {
    it(`@vzn/${dir} agrees with tests/contract/plugin-api/${dir}.txt`, () => {
      const record = path.join(RECORDS, `${dir}.txt`)
      const live = current(dir)
      if (update) writeFileSync(record, live)
      // On a failure, the diff below IS the API change: regenerate the
      // record (header) only if the change is meant to ship.
      expect(live).toBe(existsSync(record) ? readFileSync(record, 'utf8') : '')
    })
  }
})
