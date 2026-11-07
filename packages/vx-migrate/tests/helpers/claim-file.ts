// A plugin that claims root files through the `fingerprint` seam, as a
// lockfile plugin (`@vzn/vx-lockfile`'s `npm()`) claims its lockfile, for a
// fixture that must not read another package.

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function claimFile(...files: string[]): VxPlugin {
  const dir = path.join(tmpdir(), `vx-migrate-test-claim-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vx-test-claim-file' }))
  return definePlugin({ dir }, { fingerprint: { files, affected: () => undefined } })
}

/** The fixture workspace file's import of {@link claimFile}. */
export const CLAIM_FILE_IMPORT = `import { claimFile } from ${JSON.stringify(import.meta.path)}\n`
