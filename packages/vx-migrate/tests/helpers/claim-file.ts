// A plugin that claims root files through the `fingerprint` seam, as a
// lockfile plugin (`@vzn/vx-lockfile`'s `npm()`) claims its lockfile, for a
// fixture that must not read another package.

import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

// Its name's package.json, committed: one written to TMPDIR per process was
// one per `vx` a test spawned, never removed.
const dir = path.join(import.meta.dir, 'origins', 'claim-file')

export function claimFile(...files: string[]): VxPlugin {
  return definePlugin({ dir }, { fingerprint: { files, affected: () => undefined } })
}

/** The fixture workspace file's import of {@link claimFile}. */
export const CLAIM_FILE_IMPORT = `import { claimFile } from ${JSON.stringify(import.meta.path)}\n`
