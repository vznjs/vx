// A write glob that matched nothing when the task started is reported
// before the task dies on it, with the directory to grant. The report
// spelled both as absolute paths, which a committed config holds only on
// the machine that printed it; it now spells them as the config does
// (B-97, the same fix `outsideWritesHint` had in B-87).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { buildCustomConfig } from '../src/sandbox/binds.js'
import { pendingWriteGrants, resolveSandboxConfig } from '../src/sandbox/grants.js'
// ui draws the notices the modules under test say (util/notice.ts), as in vx.
import '../src/ui/index.js'

describe.skipIf(process.platform !== 'linux')('the empty write grant report', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-empty-grant-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const said = (write: string[]): string => {
    const out: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      const r = resolveSandboxConfig({ allow: { read: ['.'], write } }, root)
      const fs = buildCustomConfig({ config: r }, { allowRead: [], denyRead: [root] })!.filesystem!
      pendingWriteGrants(r, fs, [root], root)
    } finally {
      spy.mockRestore()
    }
    return out.join('')
  }

  it('spells a grant in the project from the project, and its directory as a grant', () => {
    // A directory that does not exist yet: one there is bound (punchedWriteGlobs).
    const line = said(['logs/*.log'])
    expect(line).toContain("the write grant 'logs/*.log' matches nothing yet")
    expect(line).toContain("`allow: { write: ['logs/'] }`")
    expect(line).not.toContain(root)
  })

  it('says nothing for a glob whose directory a read grant shows: it is bound', () => {
    expect(said(['*.log'])).toBe('')
  })

  it('names a subdirectory with the slash a directory grant takes', () => {
    const line = said(['gen/*.ts'])
    expect(line).toContain("the write grant 'gen/*.ts' matches nothing yet")
    expect(line).toContain("`allow: { write: ['gen/'] }`")
  })
})
