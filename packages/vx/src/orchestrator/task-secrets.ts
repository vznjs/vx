// The values of a task's secret-named variables, masked in what it prints
// and what the cache keeps of it.

import type { ExecConfig } from '../config.js'
import { heldSecrets, secretMask, type SecretMask } from '../util/index.js'

export class TaskSecrets {
  /** Null when the task has no secret. */
  mask: SecretMask | null
  private held: number

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly exec: ExecConfig,
  ) {
    this.mask = this.build()
    this.held = heldSecrets()
  }

  /** Built again once the sandbox started: its proxy token joins them. */
  refresh(): void {
    if (this.held === heldSecrets()) return
    this.held = heldSecrets()
    this.mask = this.build()
  }

  text(t: string): string {
    return this.mask?.mask(t) ?? t
  }

  private build(): SecretMask | null {
    return secretMask([process.env, this.env, this.exec.env?.define], this.exec.env?.secret)
  }
}
