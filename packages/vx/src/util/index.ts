// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  DISK_FULL_HINT,
  errorCode,
  errorDocument,
  fsRefusalHint,
  isDiskFull,
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
  gitFailure,
  notAWorkTree,
  OUT_OF_FDS_HINT,
  thrownMessage,
  wantsJson,
} from './errors.js'
export { configErrorFrame, configRefusal } from './config-frame.js'
export { envFlagOn } from './env-flag.js'
export { decodeRaw, rawBytes, rawEncode, RawUtf8Decoder } from './raw-utf8.js'
export { keysSorted, xxh3, xxh3hex } from './hash.js'
export {
  beginRun,
  mark,
  timingLines,
  restartTimings,
  span,
  stageTimes,
  type StageTime,
} from './timing.js'
export { clampInt, formatElapsed, isMeasure, MAX_TIMEOUT_MS, parseDecimalInt } from './num.js'
export {
  asTrees,
  BUN_GLOB_WILDCARDS,
  EXTGLOB,
  grantPrefix,
  isLiteralPattern,
  literalPath,
  scannable,
  taskGlobOf,
  GLOB_WILDCARDS,
  normalizeBunGlob,
  normalizeGlob,
  outputMatcher,
  outputExcluded,
  restorableOutput,
  restorableOutputDir,
  treeRoot,
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
  braceExpansionCount,
  braceRange,
  BRACE_RANGE_LIMIT,
  writableUnder,
} from './paths.js'
export {
  claimExitForSignal,
  dieOf,
  exitClaimedBySignal,
  killGraceMs,
  POST_EXIT_DRAIN_MS,
  settleWithin,
  teardownTimeoutMs,
  testTimerMs,
} from './settle.js'
export { diskBytes, formatBytes, parseDuration, parseSize, treeBytes } from './size.js'
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
export { relayedCopy, stopActedOn } from './signal-relay.js'
export { ESSENTIAL_ENV, ownEnv, withoutWorkspaceBins } from './essential-env.js'
export { gitEnv, helperEnv, hideEnvFromTasks } from './hide-env.js'
export {
  checkIgnore,
  checkIgnoreSync,
  gitCaseArgs,
  ignoreCaseLies,
  ignoredByGlobs,
  ignoredInputLine,
  ignoreProbes,
  listedSync,
  skipWorktreeSync,
  wholeIgnored,
} from './git-ignored.js'
export { CHECK_ATTR, parseCheckAttrOutput } from './git-attributes.js'
export {
  beforeExit,
  hookStarted,
  owedIfStranded,
  settleBeforeExit,
  settleStranded,
  unsettledHooks,
} from './before-exit.js'
export { OWN_DIR_HINT, refuseForeignCacheDir } from './foreign-cache-dir.js'
export { realPath, realpathOf, sameDir } from './real-path.js'
export {
  IGNORE_ALL,
  ignoreDir,
  type PendingWrite,
  refuseSymlink,
  writeAllOrNone,
  writeNoFollow,
} from './write-file.js'
export {
  heldSecrets,
  holdSecret,
  maskedCommand,
  maskedStreams,
  maskedLine,
  MASKED,
  maskStreams,
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
export {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from './dependency-spec.js'
export { stripEscapes } from './plain-text.js'
export { modeMatches, readUmask, restoredMode } from './umask.js'
