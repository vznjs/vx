// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from './dependency-spec.js'
export { computeReverseDepCount } from './priorities.js'
export {
  type ContinueMode,
  deadServerBehind,
  idleServers,
  type InputChanges,
  RestoreDemoted,
  runGraph,
  type TaskOutcome,
} from './scheduler.js'
export {
  type CacheSource,
  deriveCacheSource,
  isCacheHit,
  isPassStatus,
  TASK_STATUSES,
  type TaskStatus,
} from './task-status.js'
export {
  buildTaskGraph,
  checkGraph,
  declaredTask,
  excludeDependencies,
  expandRequested,
  type GraphRules,
  isGroupTask,
  markSurfacedDeps,
  outputsOverlap,
  outputTakenBack,
  splitTaskId,
  type TaskNode,
  undeclaredDepsError,
  unresolvedRequests,
} from './task-graph.js'
