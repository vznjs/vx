// Module contract. What a run remembers so a warm run repeats no work: file
// hashes, each task's last fold, lockfile parses, output stamps and what the
// remotes said they hold. Each memo owns its statements over the index the
// store opens; a memo is a speed-up, never the source of a cache answer.
export { FileHashStore, fileIdentity } from './file-hashes.js'
export { type FoldMemo, IndexFoldMemo } from './fold-memo.js'
export {
  FILE_HASH_RACY_MS,
  fsClockNow,
  measureFsClockLag,
  racyWindowMs,
  stampGrainMs,
} from './fs-clock.js'
export { LocalMemo, type StoreMemo } from './local-memo.js'
export { type LockfileMemo, readLockfileMemo, writeLockfileMemo } from './lockfile-memo.js'
export {
  DIR_MODE,
  LINK_MODE,
  OUTPUT_DIRS_OVER_CAP,
  type OutputDirRow,
  type OutputFileRow,
  OutputIndex,
  rowAncestors,
  wideDirMode,
  WORKSPACE_OUTPUT_PREFIX,
} from './output-index.js'
export { IndexRemoteHits, type RemoteHits } from './remote-hits.js'
