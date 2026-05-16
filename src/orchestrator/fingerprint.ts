import path from 'node:path'
import { xxh3, xxh3hexOf } from '../util/hash.js'

// Every package-manager lockfile we know about, plus the workspace
// definition files. Whichever ones exist get folded into the
// fingerprint; missing ones are skipped. Hashed in declaration order
// for determinism — adding a new entry here changes the fingerprint
// for projects that have that file present, which is fine: that's the
// whole point of bumping CACHE_VERSION when the fingerprint surface
// expands.
const WORKSPACE_FINGERPRINT_FILES = [
  // Lockfiles
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  // Workspace definition (pnpm); package.json is hashed per-project
  // via projectPackageJsonHash, not here.
  'pnpm-workspace.yaml',
]

/**
 * One hash for the workspace as a whole, derived from whichever
 * lockfile + workspace-definition files exist at the root. Folded
 * into every task's cache key so any lockfile bump (`pnpm update`,
 * `npm install`, `bun install`, …) or a workspace-shape change
 * invalidates every cached entry. Coarse but correct.
 */
export async function computeWorkspaceFingerprint(workspaceRoot: string): Promise<string> {
  let h = 0n
  for (const f of WORKSPACE_FINGERPRINT_FILES) {
    const full = path.join(workspaceRoot, f)
    const file = Bun.file(full)
    if (!(await file.exists())) continue
    h = xxh3(`${f}\0`, h)
    h = xxh3(await file.bytes(), h)
  }
  return xxh3hexOf(h)
}
