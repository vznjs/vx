// What a run tells the people and programs watching it: the event stream
// every output surface subscribes to, the terminal renderer (framed task
// output, the status line, the summary, the forecast) and the plain
// output for non-TTY runs. It renders outcomes it is handed; it never
// runs a task or reads the cache.
export {
  busLogger,
  createEventBus,
  type EventBus,
  type OutcomeView,
  outcomeWord,
  projectNode,
  projectOutcome,
  ranNoCache,
  type RunEvent,
  type RunEventSubscriber,
  type RunStartInfo,
  skippedReason,
  type TaskView,
  terminalSubscriber,
  toWireEvent,
  type WireEvent,
  wireForwarder,
} from './events.js'
export {
  type DefaultLogger,
  defaultLogger,
  type Logger,
  type OutputView,
  resolveOutputView,
  warnOf,
} from './logger.js'
export { formatPersistentList } from './framed-output.js'
export { createForecast } from './forecast.js'
export { fileLocations, fileMemo, type OutputLocation } from './path-links.js'
export { plainOutput } from './plain-output.js'
export type { LiveUsage } from './status-line.js'
export { formatOutcomeTable, formatRunSummary } from './summary.js'
