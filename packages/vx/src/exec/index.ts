// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { buildIsolatedEnv, VX_RUN_TASK_ENV, VX_RUN_WORKSPACE_ENV } from './env.js'
export {
  runCommand,
  runPersistent,
  PersistentReadyError,
  withForwardArgs,
  signalExitCode,
  exitSignal,
  type CaptureConfig,
  execWord,
} from './runner.js'
export {
  initSandbox,
  probeSandbox,
  unavailableReason,
  resetSandbox,
  untracedReason,
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
export {
  atOrUnder,
  isMountableLiteral,
  MOUNT_WILDCARDS,
  sandboxReads,
  toRealPath,
} from './sandbox-paths.js'
export { bindableWrites, punchWalls } from './sandbox-binds.js'
export { isLocalExecutor, localExecutor } from './local-executor.js'
export { holdGroups, killTree, untilGroupsGone } from './kill-tree.js'
export {
  assertExecuteResult,
  executorFallback,
  isExecutorFallback,
  selectExecutor,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecuteSandbox,
  type InputFile,
  type TaskExecutor,
  type TaskInputs,
  type TaskPlacement,
} from './executor.js'
