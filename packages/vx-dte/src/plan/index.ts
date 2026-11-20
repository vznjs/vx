// The planner: what a run needs, where each task goes and when. Pure: it
// reads no clock, wire, relay, cache or file (tests/plan-boundary.test.ts).
export { advise, type Fleets, type Play } from './advise.js'
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
export { replay, type Replayed } from './replay.js'
