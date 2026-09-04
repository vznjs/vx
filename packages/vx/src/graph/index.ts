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
  type ResourceCost,
  runGraph,
  type TaskOutcome,
  type TaskStatus,
} from './scheduler.js'
export {
  buildTaskGraph,
  detectCycle,
  expandRequested,
  isGroupTask,
  markSurfacedDeps,
  splitTaskId,
  type TaskNode,
  unresolvedRequests,
} from './task-graph.js'
