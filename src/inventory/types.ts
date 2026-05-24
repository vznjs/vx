// Workspace inventory — the JSON shape that `vx graph` emits.
//
// Each project surfaced with the tasks ("targets") it declares.
// `dependsOn` entries are emitted RAW (the strings authors wrote in
// their vx.config.ts). Resolution into a concrete dependency graph is
// handled later by the graph + package-graph modules; the inventory
// is intentionally cheap to produce and lossless for AI consumers.

export interface InventoryTarget {
  /** Task name, as declared in vx.config.ts. */
  name: string
  /** One-line description, when the author provided one. */
  description?: string
  /** Shell command. Omitted for group tasks (no exec). */
  command?: string
  /** Raw `dependsOn` strings, unresolved. Omitted when empty. */
  dependsOn?: readonly string[]
}

export interface InventoryProject {
  /** Package name from package.json. */
  name: string
  /** Absolute path to the project directory. */
  dir: string
  /** Tasks declared by this project, in vx.config.ts declaration order. */
  targets: readonly InventoryTarget[]
}

export interface Inventory {
  workspace: {
    /** Absolute path to the workspace root. */
    root: string
  }
  /** All discovered projects, sorted by directory for stable output. */
  projects: readonly InventoryProject[]
}
