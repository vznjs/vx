// Contract for the workspace module. Discover projects on disk and
// return them as a list. The default implementation reads
// pnpm-workspace.yaml / package.json's `workspaces` field / falls back
// to single-project; users who want different discovery can implement
// `Discover` themselves and inject it at the pipeline boundary.

export interface Project {
  /** `name` field from the project's package.json. Required. */
  name: string
  /** Absolute path to the project directory. */
  dir: string
}

export interface Workspace {
  /** Absolute path to the workspace root. */
  root: string
  /** Discovered projects, sorted by directory for stable ordering. */
  projects: readonly Project[]
}

export interface DiscoverOptions {
  root: string
}

export type Discover = (opts: DiscoverOptions) => Promise<Workspace>
