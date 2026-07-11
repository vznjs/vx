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
export {
  ArtifactStore,
  DEFAULT_PRINCIPAL,
  MAX_ARTIFACT_BYTES,
  type Principal,
  type Tier,
} from './artifact-store.js'
export type { BlobBackend, BlobListEntry, BlobStat } from './blob/backend.js'
export { LocalDirBackend } from './blob/local.js'
export { S3Backend, S3_META_DIGEST, S3_META_DURATION_MS } from './blob/s3.js'
export type { S3BackendConfig } from './blob/s3.js'
export { awsUriEncode, presignUrl, signRequest, UNSIGNED_PAYLOAD } from './blob/sigv4.js'
export type { PresignUrlArgs, SignRequestArgs } from './blob/sigv4.js'
export {
  MAX_REMOTE_ARTIFACT_BYTES,
  NativeCacheClient,
  readBodyBounded,
  type NativeCacheConfig,
} from './native-cache.js'
export {
  startServe,
  parseServeArgs,
  DEFAULT_SERVE_PORT,
  defaultServeSocketPath,
  resolveServePort,
  resolveS3Config,
} from './cli/serve.js'
export type { ResolvedS3Config, ServeServer } from './cli/serve.js'
export { RunQueue, DEFAULT_MAX_QUEUED } from './run-queue.js'
export type { JobView, QueuedJob, RunQueueOptions } from './run-queue.js'
export { QUEUE_PROTOCOL_VERSION } from './protocol-queue.js'
export type {
  QueueCancelMessage,
  QueueClientMessage,
  QueueServerMessage,
  QueueSubmitMessage,
} from './protocol-queue.js'
export { WorkspaceCatalog } from './workspace-catalog.js'
export type {
  CatalogProjectDetail,
  CatalogProjectSummary,
  CatalogProjectsResponse,
  CatalogTaskRow,
  CatalogTasksResponse,
  ResolvedCatalog,
} from './workspace-catalog.js'
export { handleMcpHttp, MCP_PROTOCOL_VERSION, MCP_TOOLS } from './cli/mcp-serve.js'
export {
  ENVIRONMENTS_VERSION,
  activeEnvironment,
  environmentsPath,
  isValidEnvironmentName,
  readEnvironmentsFile,
  writeEnvironmentsFile,
} from './environments.js'
export type { CloudEnvironment, EnvironmentEntry, EnvironmentsFile } from './environments.js'
export { connectCmd, envCmd, disconnectCmd, parseConnectArgs } from './cli/env.js'
export { AgentRegistry, SESSION_GC_MS, SESSION_GC_INTERVAL_MS } from './dist/registry.js'
export type { ActiveSubmission, RegisteredAgent, SubmissionBinding } from './dist/registry.js'
export { DistScheduler, DEFAULT_AGENT_TIMEOUT_MS, SUBMITTER_LABEL } from './dist/scheduler.js'
export type { ArtifactProbe, DistSchedulerArgs } from './dist/scheduler.js'
export { runAgentLoop } from './dist/agent-loop.js'
export type { AgentLoopHandle, AgentLoopOptions, AgentLoopResult } from './dist/agent-loop.js'
export { distributedBackend } from './dist/submit.js'
export type { DistributedBackendOptions } from './dist/submit.js'
export { deriveSession } from './dist/session.js'
export { agentCmd, parseAgentArgs, DEFAULT_AGENT_IDLE_TIMEOUT_MS } from './cli/agent.js'
export type { AgentArgs } from './cli/agent.js'
export { startDevHub, devSocketPath, devCmd } from './cli/dev.js'
export type { DevHub } from './cli/dev.js'
export { connectDevForwarder } from './cli/dev-client.js'
export type { DevForwarder } from './cli/dev-client.js'
export { startUiServer, bootDevframeServer } from './cli/ui-server.js'
export type { UiServer, DevframeServer } from './cli/ui-server.js'
export { serviceBackend, resolveBackend, localDevBackend } from './cli/backend.js'
export type {
  AgentHello,
  DistClientMessage,
  DistGraphNode,
  DistServerMessage,
  DistSubmitMessage,
} from './protocol-dist.js'
export {
  DIST_PROTOCOL_VERSION,
  distClientMessageToEnvelope,
  distServerMessageToEnvelope,
  distSubmitToEnvelope,
  envelopeToDistClientMessage,
  envelopeToDistServerMessage,
  envelopeToDistSubmit,
} from './protocol-dist.js'
