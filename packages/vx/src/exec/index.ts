// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { buildIsolatedEnv } from './env.js'
export {
  runCommand,
  runPersistent,
  shellQuote,
  signalExitCode,
  type CaptureConfig,
} from './runner.js'
export {
  initSandbox,
  probeSandbox,
  unavailableReason,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
  releaseBridges,
  wrapSandboxedCommand,
  type ResolvedSandboxConfig,
  type SandboxViolation,
} from './sandbox-runtime.js'
export { type DeniedCall } from './sandbox-violations.js'
export { localExecutor } from './local-executor.js'
export {
  selectExecutor,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecuteSandbox,
  type InputFile,
  type TaskExecutor,
  type TaskInputs,
  type TaskPlacement,
} from './executor.js'
