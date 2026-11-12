// The planner: what a run needs, where each task goes and when. Pure: it
// reads no clock, wire, relay, cache or file (tests/plan-boundary.test.ts).
export { advise, type Fleets } from './advise.js'
export { Placing, Queue, type Soon } from './dispatch.js'
export {
  keepLast,
  knownMisses,
  leaves,
  leftMs,
  spreadMs,
  slowdown,
  tailsMs,
  UNKNOWN_MS,
  WARM_UP_MS,
  type Need,
  type PlanTask,
  type PlanWorker,
  type Size,
  type WarmUp,
} from './model.js'
export { decide, type Forecast } from './plan.js'
export { simulate, sized } from './play.js'
export { booked, DEFAULT_STRATEGY, STRATEGIES, type Strategy } from './strategy.js'
