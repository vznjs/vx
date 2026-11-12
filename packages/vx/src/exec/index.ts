// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  buildIsolatedEnv,
  packageManagerPath,
  PM_EXEC_ENV,
  VX_RUN_TASK_ENV,
  VX_RUN_WORKSPACE_ENV,
} from './env.js'
export {
  lineEnds,
  runCommand,
  restoreTerminalModes,
  runPersistent,
  PersistentReadyError,
  withForwardArgs,
  shellQuote,
  signalExitCode,
  stopSignal,
  exitSignal,
  type CaptureConfig,
  execWord,
  maskCaptured,
  isDroppedOutputChunk,
  BoundedCapture,
  type CapturedChunk,
} from './runner.js'
export { holdGroups, killTree, markStopped, pauseTree, untilGroupsGone } from './kill-tree.js'
export { sampleTrees, type TreeUsage } from './proc-sample.js'
export {
  assertExecuteResult,
  executorFallback,
  hostPlatform,
  isExecutorFallback,
  selectExecutor,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecuteSandbox,
  type InputFile,
  type MachineReport,
  type WorkerAdvice,
  type ServerSpec,
  type TaskExecutor,
  type TaskInputs,
  type TaskPlacement,
  type ResolvedSandboxConfig,
  type SandboxViolation,
} from './executor.js'

// The process primitives the sandbox runs a task with. `sandbox` is their
// only reader outside this module (tests/module-boundaries.test.ts).
export {
  armTimeout,
  drainOrAbort,
  POST_EXIT_CUT_LINE,
  SANDBOXED_TASK,
  sandboxArgTooLongText,
  spawnFailureText,
  streamToString,
  resourceUsageToCpuRss,
  type RunResult,
} from './runner.js'
export { TaskPipes } from './pipes.js'
export { watchTree } from './proc-sample.js'
export {
  closeSignalChannel,
  groupAlive,
  releaseGroup,
  runTime,
  signalThrough,
  guardLine,
  guardSession,
  spawnGuarded,
} from './kill-tree.js'
