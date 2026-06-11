// Module contract for `orchestrator`. Cross-module imports must come
// through here (enforced by tests/module-boundaries.test.ts).

export { run, planRun } from './run.js'
export type { RunOptions, RunSummary } from './options.js'
export { defaultLogger } from './logger.js'
export type { Logger } from './logger.js'
export type { RunPlan, PlannedTask, CacheStatus } from './plan.js'
