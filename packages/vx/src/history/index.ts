// What runs leave behind, read back: the duration table a schedule learns
// from, the flakiness verdict, the queries behind `vx last` / `vx why`, and
// what a miss's key changed. Read-only SQL over the cache's database; it
// never runs, renders or writes a run.
export {
  EmptyHistoryProvider,
  type HistoryProvider,
  type HistoryTable,
  LocalHistoryProvider,
  PASS_STATUSES,
  type TaskHistory,
  type TaskResources,
} from './history.js'
export {
  detectFlaky,
  type FailureMode,
  type FlakyCandidate,
  type FlakyFinding,
  type FlakyTask,
  flakyTasks,
} from './failure-mode.js'
export {
  cacheKeyDiff,
  explainCacheKey,
  getInvocation,
  getRun,
  GROUP_VIA,
  inputWriters,
  latestRunId,
  listInvocations,
  listRuns,
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
  ListRunsArgs,
  RootCause,
  RunDetail,
  RunSummaryRow,
  WhyDidThisRerun,
} from './metrics.js'
export { createMissExplainer, type MissExplainer } from './miss-reason.js'
