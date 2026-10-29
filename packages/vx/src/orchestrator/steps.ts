// vx's own steps (reading the lock, keying, uploads, teardown) rendered as
// tasks (2026-10-15): `vx:<step>`, and `<plugin package>:setup` /
// `:teardown`. `:` is no task id's separator, so a step never collides with
// a project named `vx` or a plugin package's own `#setup` task. A step is
// not a task: no stat, history row or telemetry record counts it.
//
// A run shows only the steps it waits on, before its first task or its end
// (2026-10-16). One that runs beside the tasks (`vx:prefetch`) is a
// `background` step: never shown, and kept for `vx last` (cache/run-notes.ts).
import type { Logger } from '../report/index.js'
import type { RunStep } from '../cache/index.js'

export interface Steps {
  /** Time `work` as step `id` when steps show; else run it as it is. */
  step<T>(id: string, work: () => Promise<T>): Promise<T>
  stepSync<T>(id: string, work: () => T): T
  /** Time `work`, which the run does not wait on, as step `id` into `background`. */
  background<T>(id: string, work: () => Promise<T>): Promise<T>
  /** The background steps that have ended. */
  readonly ended: readonly RunStep[]
}

/** Steps that tell `log`, or none when nothing renders them (zero cost). */
export function createSteps(log: Logger, shown: boolean): Steps {
  const ended: RunStep[] = []
  // Timed whether or not anything shows: only a run with a remote starts one.
  const background = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    let ok = false
    try {
      const value = await work()
      ok = true
      return value
    } finally {
      ended.push({ id, durationMs: Math.round(performance.now() - t0), ok })
    }
  }
  if (!shown)
    return { step: (_id, work) => work(), stepSync: (_id, work) => work(), background, ended }
  const end = (id: string, t0: number, ok: boolean): void =>
    log.stepEnd?.(id, { durationMs: performance.now() - t0, ok })
  return {
    background,
    ended,
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
