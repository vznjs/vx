// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  DISK_FULL_HINT,
  fsRefusalHint,
  isDiskFull,
  isFsRefusal,
  isTmpdirRefusal,
  TMPDIR_HINT,
  isPermissionError,
  isUserError,
  PERMISSION_HINT,
  UserError,
  gitSpawnRefusal,
  isExecutableMissing,
  isOutOfFds,
  notAWorkTree,
  OUT_OF_FDS_HINT,
} from './errors.js'
export { xxh3, xxh3hex } from './hash.js'
export {
  beginRun,
  mark,
  printTimings,
  restartTimings,
  span,
  stageTimes,
  type StageTime,
} from './timing.js'
export { clampInt, formatElapsed, MAX_TIMEOUT_MS, parseDecimalInt } from './num.js'
export {
  asTrees,
  BUN_GLOB_WILDCARDS,
  EXTGLOB,
  grantPrefix,
  isLiteralPattern,
  GLOB_WILDCARDS,
  normalizeBunGlob,
  normalizeGlob,
  outputMatcher,
  printable,
  relPosix,
  splitNegations,
  staticPrefix,
  stripTrailingSlash,
  anyTaskGlob,
  isInstalledPath,
  taskGlob,
  wholeSubtreePrefixes,
  slashBraceExpansions,
} from './paths.js'
export {
  claimExitForSignal,
  exitClaimedBySignal,
  killGraceMs,
  settleWithin,
  teardownTimeoutMs,
} from './settle.js'
export { formatBytes, parseDuration, parseSize } from './size.js'
export {
  cgroupCpuQuota,
  cgroupMemoryLimitBytes,
  machineMemoryBytes,
  machineParallelism,
  type CgroupProbe,
} from './cgroup.js'
export { appendTail, createTail, resetTail, tailText, type Tail } from './tail.js'
export { ulid } from './ulid.js'
export { splitTaskId } from './task-id.js'
export { editDistance, listed, nearMatches, nearest } from './edit-distance.js'
export { CORE_VERBS, MOVED_VERBS } from './verbs.js'
export { isUnsupportedBun, MIN_BUN, unsupportedBunMessage } from './bun-version.js'
export { executablePath, shellArgv, taskShell } from './which.js'
export { procfsIsOwn } from './procfs.js'
export { hangupIgnored } from './hangup.js'
export { realPath } from './real-path.js'
export {
  maskedCommand,
  maskedEmitter,
  maskedLine,
  MASKED,
  secretMask,
  secretNamed,
  type SecretMask,
} from './secret-mask.js'
