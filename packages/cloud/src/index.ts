// Public API for @vzn/vx-cloud — the orchestrator service.
//
// For now this re-exports the service starters (the building blocks the
// service CLI uses). The first-party `cloud()` VxPlugin — contributing the
// backend / cache / eventSink capabilities — lands in Phase 3
// (docs/design/core-cloud-split-2026-06.md §11).

export { startServe, parseServeArgs, serveInfoPath, DEFAULT_SERVE_PORT } from './cli/serve.js'
export type { ServeServer } from './cli/serve.js'
export { startCoordinator, parseCoordinatorArgs } from './cli/coordinator.js'
export type { CoordinatorArgs, CoordinatorServer } from './cli/coordinator.js'
export { runWorker, parseWorkerArgs } from './cli/worker.js'
export type { WorkerArgs } from './cli/worker.js'
export { startDevHub, devSocketPath, devCmd } from './cli/dev.js'
export type { DevHub } from './cli/dev.js'
export { connectDevForwarder } from './cli/dev-client.js'
export type { DevForwarder } from './cli/dev-client.js'
export { startUiServer, bootDevframeServer } from './cli/ui-server.js'
export type { UiServer, DevframeServer } from './cli/ui-server.js'
export { serviceBackend, resolveBackend, localDevBackend } from './cli/backend.js'
export { prepareForCoordinator, computeTaskHashForCoord } from './coordinator-prepare.js'
export type {
  DistClientMessage,
  DistServerMessage,
  WireTaskNode,
  WireOutcome,
} from './protocol-dist.js'
export {
  distClientMessageToEnvelope,
  distServerMessageToEnvelope,
  envelopeToDistClientMessage,
  envelopeToDistServerMessage,
} from './protocol-dist.js'
