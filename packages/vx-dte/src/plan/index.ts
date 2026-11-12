// The planner: what a run needs, where each task goes and when. Pure: it
// reads no clock, wire, relay, cache or file (tests/plan-boundary.test.ts).
export { Placing, Queue, type Need, type Soon } from './dispatch.js'
export {
  advise,
  decide,
  keepLast,
  knownMisses,
  leaves,
  simulate,
  sized,
  slowdown,
  spreadMs,
  tailsMs,
  UNKNOWN_MS,
  WARM_UP_MS,
  type Fleets,
  type Forecast,
  type PlanTask,
  type PlanWorker,
  type Size,
  type WarmUp,
} from './planner.js'
export { leftMs } from './pack.js'
export { booked, DEFAULT_STRATEGY, STRATEGIES, type Strategy } from './strategy.js'
