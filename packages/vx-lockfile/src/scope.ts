/** What a lockfile is pruned to. Dirs are workspace-relative, POSIX, `.` the root. */
export interface PruneScope {
  /** The workspaces kept: the root and every pruned project. */
  readonly dirs: ReadonlySet<string>
  /** Every workspace project, kept or not: a path the lockfile reaches that is one of these and not kept is a broken subset. */
  readonly members: ReadonlySet<string>
  /** The root manifest's rewritten `workspaces` list. */
  readonly workspaces: readonly string[]
  /** Each kept dir's manifest dependencies (every bucket): yarn classic records no workspaces, so its walk starts here. */
  readonly manifests: ReadonlyMap<string, ReadonlyMap<string, string>>
}
