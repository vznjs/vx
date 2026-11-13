// What every step of a miss shares: the task's policy and key, its
// described inputs, and the per-attempt state the request, the attempt and
// the save gate read.

import type { ExecuteResult, SandboxViolation } from '../exec/index.js'
import type { ExecuteArgs } from './execute-task.js'
import type { AttemptSignal } from './attempt-signal.js'
import type { AttemptStream } from './attempt-stream.js'
import type { OutputGuard } from './attempt-outputs.js'
import type { MissInputs } from './miss-inputs.js'
import type { Placeholder, WithheldLink } from '../sandbox/index.js'
import type { TaskPolicy } from './task-policy.js'
import type { TaskSecrets } from './task-secrets.js'
import type { TreeLoad } from './telemetry.js'

/** What the last attempt's sandbox request set up, and what it refused. */
export interface AttemptSandbox {
  violations: SandboxViolation[]
  /** The empty files created for a literal write grant; swept after the attempt. */
  placeholders: Placeholder[]
  /** The linked workspace packages withheld: the key does not answer for them. */
  withheld: WithheldLink[]
  /** The dependencies' outputs: a write refused there is granted no fix. */
  upstreamOutputs: string[]
  /** Its executor listed them where it ran: `upstreamOutputs` is read here only after a refusal. */
  listedThere?: boolean
  /**
   * Where this machine's sandbox let the task write (absolute, globs kept):
   * an input changed outside them was not the task's doing. Undefined when
   * unsandboxed or run elsewhere.
   */
  writes: readonly string[] | undefined
}

export interface MissRun {
  readonly args: ExecuteArgs
  readonly policy: TaskPolicy
  readonly hash: string
  readonly inputs: MissInputs
  readonly env: NodeJS.ProcessEnv
  readonly secrets: TaskSecrets
  /**
   * The entry's command is shown by `vx why` and sent with the entry to a
   * remote cache: a value a config interpolated stays out of both.
   */
  readonly storedCommand: string
  readonly stream: AttemptStream
  readonly signal: AttemptSignal
  readonly guard: OutputGuard
  readonly sandbox: AttemptSandbox
  /** The sampling of the attempt's process tree, and what the last one saw. */
  readonly load: { untrack?: (() => TreeLoad | undefined) | undefined; seen?: TreeLoad | undefined }
  /** 1-based, the attempt running now. */
  attempt: number
}

/** The attempt before this one, which stands if this one is withdrawn. */
export interface PriorAttempt {
  readonly result: ExecuteResult
  readonly exitCode: number
}
