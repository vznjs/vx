// A run keys a claimed file from what `vx lock` recorded of it in
// `.vx/dependencies.lock`, as it takes configs from the config lock. The
// record holds no hash of the file (each change would rewrite that line and
// conflict on GitHub), so the run proves it against the claimant's own
// digests of the file as it is now: `lockfile_memos` keeps them by the
// file's hash, so after `vx lock` (which writes them) or one earlier run a
// warm run parses nothing, and a cold one parses once. A record that is not
// what the file resolves to (an install, a merge of two pull requests that
// each changed it) refuses the run before any key is folded, naming the file
// and `vx lock`. A present file with no record, or no lock at all, refuses
// when a claimant asks for it: an absent record is never read as "no
// dependencies". The other files the digests read (`extras`: a `link:`
// directory, a patch) are handed to the claimant with their recorded hashes:
// a linked directory is edited with no install, so one that moved is the
// claimant's to digest anew, not a refusal, and the proof waits for it.

import {
  DEPENDENCIES_LOCK_NAME,
  type DependenciesLock,
  lockKey,
  recordedDigests,
} from '../workspace/index.js'
import { UserError } from '../util/index.js'
import type { KeyHookContext, LockedFile } from './plugin.js'

const refused = (message: string): UserError => new UserError(message, 'VX_E_LOCK')

/**
 * `KeyHookContext.locked` for one run, over the claimed files' bytes as
 * the run read them (`readClaimedFiles`; absent ones are missing) and the
 * dependencies lock the run's discovery read (`lockedDependencies`). Each
 * recorded claimed file is checked first: one whose bytes moved, or that
 * is gone, throws here.
 */
export async function lockedFiles(
  workspaceRoot: string,
  claimed: readonly string[],
  bytes: ReadonlyMap<string, Uint8Array>,
  /** Null when the run claims no file. */
  lock: DependenciesLock | null,
  /** The run's projects, by which a project directory names its record. */
  projects: readonly { name: string; dir: string }[],
  /** The claimant's digests of `file` as it is now, each extra file with its hash now. */
  now: (
    file: string,
  ) => Promise<
    | { projects: Readonly<Record<string, string>>; extras?: Readonly<Record<string, string>> }
    | undefined
  >,
): Promise<KeyHookContext['locked']> {
  const records = new Map<string, LockedFile>()
  const nameAt = new Map(projects.map((p) => [lockKey(workspaceRoot, p.dir), p.name]))
  for (const file of claimed) {
    const rec = lock === null ? undefined : recordedDigests(lock, file)
    if (rec === undefined) continue
    const stale = (): UserError => refused(`${file} changed since \`vx lock\`: run \`vx lock\``)
    if (!bytes.has(file)) throw stale()
    const live = await now(file)
    if (live === undefined) throw stale()
    // An extra file that moved since is the claimant's to digest anew.
    if (Bun.deepEquals(live.extras ?? {}, rec.extras)) {
      for (const p of projects)
        if (rec.has(p.name) && (live.projects[p.name] || undefined) !== rec.of(p.name))
          throw stale()
    }
    records.set(file, {
      extras: rec.extras,
      digest(projectDir) {
        const dir = lockKey(workspaceRoot, projectDir)
        const name = nameAt.get(dir)
        if (name === undefined || !rec.has(name))
          throw refused(`${dir} is not in ${DEPENDENCIES_LOCK_NAME}: run \`vx lock\``)
        return rec.of(name)
      },
    })
  }
  return async (file) => {
    const rec = records.get(file)
    if (rec !== undefined || !bytes.has(file)) return rec
    throw refused(`${file} is not in ${DEPENDENCIES_LOCK_NAME}: run \`vx lock\``)
  }
}
