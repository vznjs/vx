// What the orchestrator and its agents say to each other through the relay
// (the relay never reads it). Bundles ride as base64 `part`s, in order,
// before the message that names their count.

/** An agent's `join` info. */
export interface AgentInfo {
  readonly v: 1
  readonly size: string
  /** Tasks it runs at once: its size's `cpu`. */
  readonly slots: number
  /** Its checkout's `HEAD`: an agent on another commit is refused. */
  readonly commit: string
}

export type ToAgent =
  | { type: 'part'; task: string; data: string }
  | {
      type: 'run'
      task: string
      /** The orchestrator's workspace root, swapped for the agent's in `env`. */
      root: string
      command: string
      /** Workspace-relative, as `project` is. */
      cwd: string
      project: string
      env: Record<string, string>
      timeoutMs?: number
      outputs: { files: string[]; workspaceFiles: string[] }
    }
  | { type: 'cancel'; task: string }
  | { type: 'refused'; reason: string }

export type ToOrchestrator =
  | { type: 'part'; task: string; data: string }
  | { type: 'end'; task: string; parts: number }
