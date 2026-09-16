// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { buildIsolatedEnv, VX_RUN_TASK_ENV, VX_RUN_WORKSPACE_ENV } from './env.js'
export {
  runCommand,
  runPersistent,
  shellQuote,
  signalExitCode,
  type CaptureConfig,
  execWord,
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
  dependencyReason,
  socketPathRefusal,
  thrownReason,
} from './sandbox-runtime.js'
export { type DeniedCall } from './sandbox-violations.js'
export { localExecutor } from './local-executor.js'
export { killTree } from './kill-tree.js'
export {
  assertExecuteResult,
  selectExecutor,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecuteSandbox,
  type InputFile,
  type TaskExecutor,
  type TaskInputs,
  type TaskPlacement,
} from './executor.js'
