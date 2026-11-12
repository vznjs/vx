// A run's history writes into an open cache's index: `RunHistory` over the
// handle the cache exposes, gated as the cache's own writes are.

import type { InvocationRecord, MeasureRecord, RunRecord } from './layer.js'
import { type Cache, indexDb, indexError, indexWritable, valueDigest } from './cache.js'
import { RunHistory, type RunHead } from './run-history.js'

/** A run's history writes into a cache's index. */
export interface HistoryWrites {
  recordRun(run: RunRecord): void
  recordRuns(runs: readonly RunRecord[], head?: RunHead): void
  /** A run's plugin measures, each its last (`PluginSetupContext.measure`), as timings. */
  recordMeasures(measures: readonly MeasureRecord[], head: RunHead): void
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  recordRemoteErrors(runId: string, errors: readonly (readonly [string, string])[]): void
}

const writers = new WeakMap<Cache, HistoryWrites>()

/**
 * The history writes into `cache`'s index, one per cache. A cache this
 * user cannot write records none: `readOnlyNotice` said so once.
 */
export function runHistory(cache: Cache): HistoryWrites {
  let writes = writers.get(cache)
  if (writes === undefined) {
    writes = historyWrites(cache)
    writers.set(cache, writes)
  }
  return writes
}

function historyWrites(cache: Cache): HistoryWrites {
  const history = new RunHistory(indexDb(cache), valueDigest(cache))
  const write = (op: () => void): void => {
    if (!indexWritable(cache)) return
    try {
      op()
    } catch (err) {
      throw indexError(cache, err)
    }
  }
  return {
    recordRun: (run) => write(() => history.recordRun(run)),
    recordRuns: (runs, head) => write(() => history.recordRuns(runs, head)),
    recordMeasures: (measures, head) => {
      if (measures.length > 0) write(() => history.recordMeasures(measures, head))
    },
    recordRunBundle: (bundle) => write(() => history.recordRunBundle(bundle)),
    recordRemoteErrors: (runId, errors) => write(() => history.recordRemoteErrors(runId, errors)),
  }
}
