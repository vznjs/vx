import {
  type BranchScope,
  LayeredCache,
  type Cache,
  type CachePolicy,
  type RemoteCacheLayer,
} from '../../src/cache/index.js'

/** One remote over `local`, gated by `policy`'s remote axes (all on by default). */
export function layeredOver(
  local: Cache,
  remote: RemoteCacheLayer,
  opts: {
    policy?: CachePolicy
    onRemoteError?: (err: Error) => void
    branch?: BranchScope
    uploadConcurrency?: number
  } = {},
): LayeredCache {
  return new LayeredCache(
    local,
    [
      {
        remote,
        read: opts.policy?.remoteRead ?? true,
        write: opts.policy?.remoteWrite ?? true,
        ...(opts.onRemoteError !== undefined ? { onError: opts.onRemoteError } : {}),
      },
    ],
    opts.branch,
    opts.uploadConcurrency,
  )
}
