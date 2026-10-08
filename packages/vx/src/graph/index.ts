// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from './dependency-spec.js'
export {
  type ContinueMode,
  deadServerBehind,
  idleServers,
  type InputChanges,
  RestoreDemoted,
  runGraph,
  type TaskOutcome,
  type TaskStatus,
} from './scheduler.js'
export {
  buildTaskGraph,
  checkGraph,
  declaredTask,
  excludeDependencies,
  expandRequested,
  isGroupTask,
  markSurfacedDeps,
  outputsOverlap,
  outputTakenBack,
  splitTaskId,
  type TaskNode,
  undeclaredDepsError,
  unresolvedRequests,
} from './task-graph.js'
