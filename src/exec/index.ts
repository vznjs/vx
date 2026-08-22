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
  deniedCalls,
  initSandbox,
  probeSandbox,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
  type DeniedCall,
  type SandboxViolation,
} from './sandbox-runtime.js'
export {
  localExecutor,
  selectExecutor,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecuteSandbox,
  type TaskExecutor,
} from './executor.js'
