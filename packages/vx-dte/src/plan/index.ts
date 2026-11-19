// The planner: what a run needs, where each task goes and when. Pure: it
// reads no clock, wire, relay, cache or file (tests/plan-boundary.test.ts).
export { advise, type Fleets } from './advise.js'
export {
  bookedCores,
  leaves,
  MIN_CORES,
  spreadMs,
  WARM_UP_MS,
  wholeCores,
  type Need,
  type PlanTask,
  sized,
  type Size,
} from './model.js'
export { commands, Planner, type PlannerSize } from './planner.js'
export { replay } from './replay.js'
