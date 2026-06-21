// Module contract for `orchestrator`. Cross-module imports must come
// through here (enforced by tests/module-boundaries.test.ts).

export { run, planRun } from './run.js'
export type { RunOptions, RunSummary } from './options.js'
export { defaultLogger, resolveOutputView } from './logger.js'
export type { Logger, OutputView } from './logger.js'
export type { RunPlan, PlannedTask, CacheStatus } from './plan.js'
export { createEventBus, wireForwarder, toWireEvent, projectOutcome } from './events.js'
export type {
  EventBus,
  RunEvent,
  RunEventSubscriber,
  WireEvent,
  TaskView,
  OutcomeView,
} from './events.js'
export { createVxSurface } from './devframe-surface.js'
export { createWireRenderer } from './wire-render.js'
export { optionsToRequest, requestToOptions } from './protocol.js'
export type {
  ClientMessage,
  RunRequest,
  RunResult,
  ServerMessage,
  WireOutcome,
  WireTaskNode,
} from './protocol.js'
export {
  EmptyHistoryProvider,
  type HistoryProvider,
  type HistoryTable,
  LocalHistoryProvider,
  type TaskHistory,
} from './history.js'
export { computePredictedPriorities } from './predict.js'
export {
  installPlugins,
  type InstallPluginsArgs,
  type Plugin,
  type PluginContext,
  type PluginHookHandlers,
  type PluginHookName,
} from './plugin.js'
