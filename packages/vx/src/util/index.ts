// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  DISK_FULL_HINT,
  errorCode,
  errorDocument,
  fsRefusalHint,
  isDiskFull,
  configThrow,
  isFsRefusal,
  isTmpdirRefusal,
  TMPDIR_HINT,
  isPermissionError,
  isUserError,
  PERMISSION_HINT,
  refusal,
  type RefusalParts,
  UserError,
  gitSpawnRefusal,
  isExecutableMissing,
  isOutOfFds,
  notAWorkTree,
  OUT_OF_FDS_HINT,
  thrownMessage,
  wantsJson,
} from './errors.js'
export { configErrorFrame, configRefusal } from './config-frame.js'
export { envFlagOn } from './env-flag.js'
export {
  detectColors,
  dumbTerminal,
  ERROR,
  identityColor,
  paint,
  SUCCESS,
  WARN,
  type ColorSupport,
} from './colors.js'
export { barWidth, gradientRule } from './report.js'
import * as ui from './ui.js'
export { refusalNotice, sayLine, sayNotice } from './refusal-notice.js'
export { ui }
export { keysSorted, xxh3, xxh3hex } from './hash.js'
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
  literalPath,
  GLOB_WILDCARDS,
  normalizeBunGlob,
  normalizeGlob,
  outputMatcher,
  outputNever,
  restorableOutput,
  printable,
  hasControl,
  relPosix,
  DOT_VX_GITATTRIBUTES,
  DOT_VX_GITIGNORE,
  splitNegations,
  staticPrefix,
  stripTrailingSlash,
  anyTaskGlob,
  isInstalledPath,
  taskGlob,
  outputDirPrefixes,
  wholeSubtreePrefixes,
  slashBraceExpansions,
  braceAlternatives,
  braceRange,
  BRACE_RANGE_LIMIT,
  writableUnder,
} from './paths.js'
export {
  claimExitForSignal,
  exitClaimedBySignal,
  killGraceMs,
  settleWithin,
  teardownTimeoutMs,
  testTimerMs,
} from './settle.js'
export { formatBytes, parseDuration, parseSize, treeBytes } from './size.js'
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
export { CORE_VERBS } from './verbs.js'
export { isUnsupportedBun, MIN_BUN, unsupportedBunMessage } from './bun-version.js'
export { executablePath, shellArgv, taskShell } from './which.js'
export { procfsIsOwn } from './procfs.js'
export { hangupIgnored } from './hangup.js'
export { ESSENTIAL_ENV } from './essential-env.js'
export { gitEnv, helperEnv, hideEnvFromTasks } from './hide-env.js'
export {
  checkIgnore,
  checkIgnoreSync,
  ignoreProbes,
  listedSync,
  wholeIgnored,
} from './git-ignored.js'
export { realPath, realpathOf } from './real-path.js'
export {
  maskedCommand,
  maskedEmitter,
  maskedLine,
  MASKED,
  secretMask,
  secretNamed,
  type SecretMask,
} from './secret-mask.js'
export {
  isSecretUnavailable,
  SecretBroker,
  type PluginSecrets,
  type SecretRequest,
  type SecretStore,
  type SecretUnavailable,
  type SecretUnavailableReason,
} from './secrets.js'
export { terminalOf, type SecretTerminal } from './hidden-prompt.js'
