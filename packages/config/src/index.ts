// Project and workspace config types live here.
//
// The schema is intentionally unspecified at this stage — `defineProject` and
// `defineWorkspace` are identity helpers that exist purely so user configs can
// be authored with `satisfies`-style inference once the shape lands.

export interface ProjectConfig {
  name: string
  // tasks, inputs, outputs, etc. — to be designed.
}

export interface WorkspaceConfig {
  // workspace-level defaults — to be designed.
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
