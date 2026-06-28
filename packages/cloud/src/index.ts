// Public API for @vzn/vx-cloud — the orchestrator service + the first-party
// cloud plugin.
//
// `cloud()` is the VxPlugin contributing the backend / cache / telemetry
// capabilities against core's plugin interface. The telemetry sink pushes the
// canonical RunSummaryRecord to the cloud ingest endpoint; IngestStore is the
// cloud-owned analytics store the hosted dashboard reads from. See
// docs/design/observability-architecture-2026-06.md. The rest re-exports the
// service starters (the building blocks the service CLI uses).

export { cloud } from './plugin.js'
export type { CloudPluginOptions } from './plugin.js'
export { IngestStore } from './ingest-store.js'
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
