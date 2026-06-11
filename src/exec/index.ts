// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { buildIsolatedEnv } from './env.js'
export { runCommand, runPersistent, signalExitCode } from './runner.js'
export {
  initSandbox,
  probeSandbox,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
  type SandboxViolation,
} from './sandbox-runtime.js'
