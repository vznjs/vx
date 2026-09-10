import path from 'node:path'
import { xxh3 } from '../util/index.js'

// Every package-manager lockfile we know about, plus the workspace
// definition files. Whichever ones exist get folded into the
// fingerprint; missing ones are skipped. Hashed in declaration order
// for determinism — adding a new entry here changes the fingerprint
// for projects that have that file present, which is fine: that's the
// whole point of bumping CACHE_VERSION when the fingerprint surface
// expands.
// Exported so `--affected` can consult the SAME list. A change to any of
// these re-keys every task in the workspace, so selection has to widen to
// match — two copies of this list would silently drift into a run that
// rebuilds everything while selecting nothing.
export const WORKSPACE_FINGERPRINT_FILES = [
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

// DELIBERATELY ABSENT: `vx.workspace.{ts,mts,js,mjs}`. Everything it can
// declare — `concurrency`, `cacheDir`, `timeout`, and the
// plugin list — is placement, storage or observability, never what a
// command produces; core's three seams may change WHERE a task runs, not
// WHAT it runs (architecture principle #3). Folding it in would also do
// active harm: a laptop declaring only the local plugins and a CI runner
// declaring `reapi()` would compute different fingerprints and share not
// one cache entry — the same split the rejected `NODE_OPTIONS` non-goal
// describes. A per-task input that genuinely varies belongs in
// `cache.inputs`, which is the surface built for it.

/**
 * One hash for the workspace as a whole, derived from whichever
 * lockfile + workspace-definition files exist at the root. Folded
 * into every task's cache key so any lockfile bump (`pnpm update`,
 * `npm install`, `bun install`, …) or a workspace-shape change
 * invalidates every cached entry. Coarse but correct.
 */
export async function computeWorkspaceFingerprint(workspaceRoot: string): Promise<string> {
  return (await computeWorkspaceFingerprints(workspaceRoot, NONE)).all
}

const NONE: ReadonlySet<string> = new Set()

export interface WorkspaceFingerprints {
  /** Every file folded — what the config-evaluation cache keys on. */
  readonly all: string
  /**
   * The same fold minus the files a plugin claims (`VxPlugin.fingerprint`)
   * — what every task key folds. Identical to `all` with nothing claimed.
   */
  readonly unclaimed: string
}

/**
 * Both digests from one read of each file. A claimed file leaves the key
 * digest entirely (its name too): the claimant folds what it means per
 * project, and a fold of "present" would still re-key the workspace when
 * the file appeared.
 */
export async function computeWorkspaceFingerprints(
  workspaceRoot: string,
  claimed: ReadonlySet<string>,
): Promise<WorkspaceFingerprints> {
  let all = 0n
  let unclaimed = 0n
  for (const f of WORKSPACE_FINGERPRINT_FILES) {
    const full = path.join(workspaceRoot, f)
    const file = Bun.file(full)
    if (!(await file.exists())) continue
    const bytes = await file.bytes()
    all = xxh3(`${f}\0`, all)
    all = xxh3(bytes, all)
    if (claimed.has(f)) continue
    unclaimed = xxh3(`${f}\0`, unclaimed)
    unclaimed = xxh3(bytes, unclaimed)
  }
  return { all: hex(all), unclaimed: hex(unclaimed) }
}

function hex(h: bigint): string {
  return h.toString(16).padStart(16, '0')
}
