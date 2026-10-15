// vx's own steps (reading the lock, keying, uploads, teardown) rendered as
// tasks (M, 2026-10-15): `vx:<step>`, and `<plugin package>:setup` /
// `:teardown`. `:` is no task id's separator, so a step never collides with
// a project named `vx` or a plugin package's own `#setup` task. A step is
// not a task: no stat, history row or telemetry record counts it.
import type { Logger } from '../report/index.js'

export interface Steps {
  /** Time `work` as step `id` when steps show; else run it as it is. */
  step<T>(id: string, work: () => Promise<T>): Promise<T>
  stepSync<T>(id: string, work: () => T): T
}

const unseen: Steps = {
  step: (_id, work) => work(),
  stepSync: (_id, work) => work(),
}

/** Steps that tell `log`, or none when nothing renders them (zero cost). */
export function createSteps(log: Logger, shown: boolean): Steps {
  if (!shown) return unseen
  const end = (id: string, t0: number, ok: boolean): void =>
    log.stepEnd?.(id, { durationMs: performance.now() - t0, ok })
  return {
    async step(id, work) {
      const t0 = performance.now()
      log.stepStart?.(id)
      let ok = false
      try {
        const value = await work()
        ok = true
        return value
      } finally {
        end(id, t0, ok)
      }
    },
    stepSync(id, work) {
      const t0 = performance.now()
      log.stepStart?.(id)
      let ok = false
      try {
        const value = work()
        ok = true
        return value
      } finally {
        end(id, t0, ok)
      }
    },
  }
}
