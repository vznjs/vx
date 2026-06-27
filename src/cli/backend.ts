// Execution as a pluggable backend — the same idea as the cache's
// local/remote split, applied to running tasks. `vx run` resolves a
// backend and calls `run(request)`; it neither knows nor cares whether the
// work happened in-process or was delegated to a service. The DEFAULT is
// pure in-process; routing to a service (local or hosted) is a `backend`
// plugin capability contributed by `@vzn/vx-cloud`, never core.

import {
  run as runOrchestrator,
  projectOutcome,
  requestToOptions,
  type RunBackend,
} from '../orchestrator/index.js'

/** Run in-process via `run()` — core's default backend. Byte-identical to a plain `run()`. */
export function localBackend(): RunBackend {
  return {
    async run(request) {
      const summary = await runOrchestrator(requestToOptions(request))
      return { ok: summary.ok, outcomes: summary.outcomes.map(projectOutcome) }
    },
  }
}
