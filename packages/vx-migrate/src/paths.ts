// The two package.json / path readings every mapper in this package shares.
//
// Both existed as per-file copies. `relPosix` had FOUR (migrate-turbo,
// migrate-nx, turbo/turbo-map, nx-command), three identical and one that
// mapped the same-directory case to `.` — a difference its own caller made
// unreachable by returning early, which is the kind of divergence a copy
// acquires quietly. `packageScripts` had two, and core guards the same read
// while these did not (item 446).
//
// Neither divergence was reachable in a realistic workspace, which is why
// this is consolidation rather than a fix. The reason to do it anyway is
// item 445: one copy in this package HAD drifted into a defect, and the
// cheapest moment to collapse a duplicate is before it does.

import path from 'node:path'
import type { ProjectMeta } from '@vzn/vx'

/** `to` relative to `from`, POSIX-separated — core's `relPosix`, which is not on the façade. */
export function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

/**
 * A project's `scripts` map, or `{}` when the file holds something else.
 *
 * package.json is a system boundary, so the value is whatever the file
 * holds: a string or an array would enumerate its INDICES as script names,
 * and indexing one by a task named `0` yields a single character that reads
 * as a usable command. Core's `migrate-scripts.ts` guards this read; these
 * mappers did not.
 */
export function packageScripts(meta: ProjectMeta): Record<string, unknown> {
  const raw = (meta.packageJson as unknown as { scripts?: unknown }).scripts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}
