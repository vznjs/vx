// The deprecation path docs/design/versioning-1.0.md promises: a field a
// release removed is refused naming its replacement and the version that
// removed it, not as an unknown field. `REMOVED_FIELDS` in config-schema.ts
// is the table; these rows hold one example exactly and every entry to the
// same shape.

import { describe, expect, it } from 'bun:test'
import { REMOVED_FIELDS, validateProjectConfig } from '../src/workspace/config-schema.js'

const CFG = '/ws/pkg/vx.config.ts'

function execRefusal(exec: Record<string, unknown>): string | null {
  try {
    validateProjectConfig({ tasks: { t: { exec } } } as never, CFG)
    return null
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return (err as Error).message
  }
}

describe('a removed config field names its replacement (versioning-1.0.md § Deprecation)', () => {
  it('exec.resources, removed in 0.0.19, points at @vzn/vx-schedule-history', () => {
    expect(execRefusal({ command: 'true', resources: { memory: 512 } })).toBe(
      `${CFG}: tasks.t.exec has field "resources", which vx 0.0.19 removed — use ` +
        "`@vzn/vx-schedule-history`, which learns each task's reservation from its run history " +
        "(declare one by hand with its `reservations: { 'pkg#task': { cpus, memory } }`)",
    )
    // Control: a field no release ever had is still an unknown field.
    expect(execRefusal({ command: 'true', resourcez: 1 })).toBe(
      `${CFG}: tasks.t.exec has unknown field "resourcez" (allowed: command, env, persistent, ` +
        'remote, retries, sandbox, timeout)',
    )
  })

  it('every removed field is out of its level and says which release removed it', () => {
    expect(REMOVED_FIELDS.size).toBeGreaterThan(0)
    for (const [allowed, removed] of REMOVED_FIELDS) {
      for (const [field, removal] of Object.entries(removed)) {
        // A name back in its level would never reach its removal message.
        expect({ field, accepted: allowed.has(field) }).toEqual({ field, accepted: false })
        expect({ field, removedIn: /^\d+\.\d+\.\d+$/.test(removal.removedIn) }).toEqual({
          field,
          removedIn: true,
        })
        expect(removal.use.length).toBeGreaterThan(0)
      }
    }
  })
})
