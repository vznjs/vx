// Module contract for `orchestrator`. Cross-module imports must come
// through here (enforced by tests/module-boundaries.test.ts).

export { run, planRun } from './run.js'
export type { RunOptions, RunSummary } from './options.js'
export { defaultLogger, resolveOutputView } from './logger.js'
export type { Logger, OutputView } from './logger.js'
export type { RunPlan, PlannedTask, CacheStatus } from './plan.js'
export { createEventBus } from './events.js'
export type { EventBus, RunEvent } from './events.js'
export { createVxSurface } from './devframe-surface.js'
