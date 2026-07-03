// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { DependencySpecError, parseDependencySpec, type DependencySpec } from './dependency-spec.js'
export { type ContinueMode, runGraph, type TaskOutcome, type TaskStatus } from './scheduler.js'
export {
  buildTaskGraph,
  expandRequested,
  isGroupTask,
  markSurfacedDeps,
  type TaskNode,
} from './task-graph.js'
