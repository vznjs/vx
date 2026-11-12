// Module contract. Cross-module imports must come through here
// (tests/module-boundaries.test.ts). The sandbox takes a task's request
// and returns its result plus the violations it saw; what it exports is
// only what the orchestrator and the façade call.

export {
  probeSandbox,
  releaseBridges,
  resetSandbox,
  runSandboxed,
  untracedReason,
  wrapSandboxedCommand,
} from './runtime.js'
export { atOrUnder, MOUNT_WILDCARDS, replacedBySandbox, sandboxReads, toRealPath } from './paths.js'
export { keyedOutsideGrants } from './binds.js'
export {
  commandWriteReach,
  dependencyReads,
  grantedWriteGlobs,
  mayWriteFingerprint,
  placeholderSweeper,
  prepareSandbox,
  reachedWithheld,
  sandboxRequestFor,
  sweepPlaceholders,
  undeclaredWriteReach,
  untouchedPlaceholderLine,
  withheldLinkLine,
  type Placeholder,
  type SandboxRequest,
  type WithheldLink,
  type WriteReach,
} from './request.js'
export { misrootedWriteHint, perRunWriteHint, rootFileWriteHint, sandboxFix } from './fix.js'
