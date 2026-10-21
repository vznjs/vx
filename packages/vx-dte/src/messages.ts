// What the orchestrator and its agents say to each other through the relay
// (the relay never reads it). Bundles ride as base64 `part`s, in order,
// before the message that names their count.

/** An agent's `join` info. */
export interface AgentInfo {
  readonly v: 1
  readonly size: string
  /** What its machine has (core's `machineParallelism`, `machineMemoryBytes`), not what its size says. */
  readonly cores: number
  readonly memory: number
  /** Its checkout's `HEAD`: an agent on another commit is refused. */
  readonly commit: string
}

/** One task an agent is sent; its dependencies' files came first as `part`s. */
export interface RunOrder {
  task: string
  command: string
  /** Workspace-relative, as `project` is. */
  cwd: string
  project: string
  env: Record<string, string>
  timeoutMs?: number
  outputs: { files: string[]; workspaceFiles: string[] }
  /** Its recorded peak: the agent starts it when that much is free. */
  cores: number
  memory: number
}

export type ToAgent =
  | { type: 'part'; task: string; data: string }
  /** Tasks for its free capacity and a little more; `root` is swapped for the agent's in `env`. */
  | { type: 'batch'; root: string; tasks: RunOrder[] }
  | { type: 'cancel'; task: string }
  | { type: 'refused'; reason: string }

export type ToOrchestrator =
  | { type: 'part'; task: string; data: string }
  | { type: 'end'; task: string; parts: number }
