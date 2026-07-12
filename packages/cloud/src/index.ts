// Public API for @vzn/vx-cloud — the self-hosted platform + the first-party
// cloud plugin.
//
// `cloud()` is the VxPlugin contributing the backend / cache / telemetry
// capabilities against core's plugin interface. The telemetry sink pushes the
// canonical RunSummaryRecord to the platform's ingest endpoint, persisted in
// Postgres (docs/design/cloud-platform-2026-07.md). `startServer` is the
// platform entrypoint; the rest re-exports the building blocks the CLI uses.

export { cloud } from './plugin.js'
export type { CloudPluginOptions } from './plugin.js'
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
export { startServer, resolveServerConfig } from './cli/server.js'
export type { PlatformServer, ServerConfig } from './cli/server.js'
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
