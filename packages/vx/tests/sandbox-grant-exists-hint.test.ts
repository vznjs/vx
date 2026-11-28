// `mkdir w` under `write: ['w/']`, the grant the fix line names for it,
// failed "File exists": vx makes a directory grant before the run so the
// sandbox can mount it, and the run named nothing but the cwd note.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { grantExistsHint } from '../src/sandbox/hints.js'

describe('the existing grant hint', () => {
  let dir = ''
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-grant-exists-')))
    mkdirSync(path.join(dir, 'w'))
    writeFileSync(path.join(dir, 'f'), '')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const hint = (lines: string[], grants: string[]) =>
    grantExistsHint(
      lines,
      grants.map((g) => path.join(dir, g)),
      dir,
      dir,
    )?.line

  it('names mkdir -p for a directory grant a plain mkdir met', () => {
    expect(hint(["mkdir: cannot create directory 'w': File exists"], ['w'])).toBe(
      "vx: the write grant 'w/' is a directory when the task starts (vx makes it, so the " +
        'sandbox can mount it), so a plain `mkdir` of it meets "File exists". Use `mkdir -p w`.',
    )
    expect(hint([`mkdir: ${dir}/w: File exists`], ['w'])).toContain('`mkdir -p w`')
  })

  it('says nothing for a file grant, another path, or another error', () => {
    // CONTROL: each differs from the case above in one thing.
    expect(hint(["mkdir: cannot create directory 'f': File exists"], ['f'])).toBeUndefined()
    expect(hint(["mkdir: cannot create directory 'ww': File exists"], ['w'])).toBeUndefined()
    expect(hint(["rm: cannot remove 'w': Permission denied"], ['w'])).toBeUndefined()
  })
})
