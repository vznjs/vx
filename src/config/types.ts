// Public schema for vx project configuration.
//
// Intentionally empty for now. Future extension modules (tasks, cache,
// sandbox, …) will own their own slice of the schema and validate it
// themselves; the config module is just the bootstrap that discovers
// and loads `vx.config.{ts,mts,js,mjs}` files.

export interface ProjectConfig {
  // intentionally empty
}

export interface ConfigSource {
  /** Identifier used in error messages — typically the package name. */
  readonly name: string
  /** Directory to look for `vx.config.{ts,mts,js,mjs}` in. */
  readonly dir: string
}

export interface LoadedConfig {
  readonly source: ConfigSource
  readonly config: ProjectConfig
}

export type LoadConfigs = (sources: readonly ConfigSource[]) => Promise<readonly LoadedConfig[]>
