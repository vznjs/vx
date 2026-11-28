// What runs leave behind, read back: the duration table a schedule learns
// from, the flakiness verdict, the queries behind `vx last` / `vx why`, and
// what a miss's key changed. Read-only SQL over the cache's database; it
// never runs, renders or writes a run.
export {
  EmptyHistoryProvider,
  type HistoryProvider,
  type HistoryTable,
  type LocalHistory,
  type LocalHistoryOptions,
  type MeasureForecast,
  localHistory,
  LocalHistoryProvider,
  PASS_STATUSES,
  type TaskHistory,
  type TaskResources,
} from './history.js'
export {
  detectFlaky,
  knownFlaky,
  type FailureMode,
  type FlakyCandidate,
  type FlakyFinding,
  type FlakyTask,
  flakyTasks,
} from './failure-mode.js'
export {
  cacheKeyDiff,
  createMissExplainer,
  diffsOlderRun,
  explainCacheKey,
  getInvocation,
  getRun,
  GROUP_VIA,
  inputWriters,
  savedOutputs,
  latestRunId,
  listInvocations,
  listRuns,
  recordedTasks,
  rootCauses,
  upstreamTask,
  whyDidThisRerun,
} from './metrics.js'
export type {
  CacheEntryRow,
  CacheKeyDiff,
  CacheKeyExplanation,
  InputDiffEntry,
  InputWriter,
  InvocationDetail,
  ListInvocationsArgs,
  MissExplainer,
  ListRunsArgs,
  RootCause,
  RunDetail,
  RunSummaryRow,
  WhyDidThisRerun,
} from './metrics.js'
// A run id as a user types it: whole, or a unique prefix (`vx last`, `vx why`).
export { resolveRunId, shortRunId } from './run-id.js'
// The write side: a run's rows, written at its end (`runHistory`), its hits
// as one packed row a reader writes out (`expandHits`), and the notes it keeps.
export {
  expandHits,
  type HistoryWrites,
  type InvocationRecord,
  type MeasureRecord,
  type RunHits,
  type RunRecord,
  runHistory,
} from './run-history.js'
export { encodeHits, HIT, HitBatch, hitRecords, type HitRows } from './hit-rows.js'
export {
  type KeptFailure,
  keepRunNotes,
  keptFailures,
  keptSteps,
  keptWarnings,
  type RunNotes,
  type RunStep,
} from './run-notes.js'
