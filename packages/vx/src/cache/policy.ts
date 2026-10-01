// The run-level cache policy: four axes (local/remote × read/write) and
// the `--cache=<spec>` grammar that sets them. Pure data + parsing; no I/O.

import { UserError } from '../util/index.js'

/**
 * Independent read/write control over the two cache layers (local +
 * remote). Replaces the old single `noCache` boolean: each axis can be
 * toggled on its own so `--force` (re-execute but still refresh the
 * cache) is distinct from `--no-cache` (disable everything).
 *
 * The task-artifact get/save path is gated, and the local axes also gate
 * the local store's config-evaluation reads and writes and its file-hash
 * writes (`cache.ts`). `recordRun`, `stats`, `prune`, key derivation, and
 * prefetch-ingest are never affected — they are bookkeeping/analytics
 * that a run policy has no business disabling.
 */
export interface CachePolicy {
  localRead: boolean
  localWrite: boolean
  remoteRead: boolean
  remoteWrite: boolean
}

/** All four axes on — the default when no cache flag is passed. */
export const FULL_CACHE_POLICY: CachePolicy = {
  localRead: true,
  localWrite: true,
  remoteRead: true,
  remoteWrite: true,
}

/**
 * Parse a `--cache=<spec>` value into a `CachePolicy`, starting from a
 * base (defaults to {@link FULL_CACHE_POLICY}). The spec is a
 * comma-separated list of `layer:flags` segments where `layer` is
 * `local` or `remote` and `flags` is any subset of `r` (read) and `w`
 * (write), order-independent and possibly empty.
 *
 * A mentioned layer is set EXACTLY to its flags (read = includes `r`,
 * write = includes `w`); an unmentioned layer keeps its base value.
 * So `local:rw,remote:r` = remote read-only, `remote:` = remote fully
 * off, `local:r` = local read-only with remote untouched.
 *
 * Throws a {@link UserError} on an unknown layer, an unknown flag, a
 * duplicated flag, a missing colon, or a repeated layer.
 */
export function parseCachePolicy(spec: string, base: CachePolicy = FULL_CACHE_POLICY): CachePolicy {
  const out: CachePolicy = { ...base }
  const seen = new Set<string>()
  for (const rawSeg of spec.split(',')) {
    const seg = rawSeg.trim()
    if (seg.length === 0) continue
    const colon = seg.indexOf(':')
    if (colon < 0) {
      throw new UserError(`invalid --cache segment '${seg}': expected '<layer>:<flags>'`)
    }
    const layer = seg.slice(0, colon)
    const flags = seg.slice(colon + 1)
    if (layer !== 'local' && layer !== 'remote') {
      throw new UserError(`invalid --cache layer '${layer}': expected 'local' or 'remote'`)
    }
    if (seen.has(layer)) {
      throw new UserError(`--cache layer '${layer}' specified twice`)
    }
    seen.add(layer)
    const flagSet = new Set<string>()
    for (const ch of flags) {
      if (ch !== 'r' && ch !== 'w') {
        throw new UserError(`invalid --cache flag '${ch}' for '${layer}': expected 'r' and/or 'w'`)
      }
      if (flagSet.has(ch)) {
        throw new UserError(`--cache flag '${ch}' repeated for '${layer}'`)
      }
      flagSet.add(ch)
    }
    if (layer === 'local') {
      out.localRead = flagSet.has('r')
      out.localWrite = flagSet.has('w')
    } else {
      out.remoteRead = flagSet.has('r')
      out.remoteWrite = flagSet.has('w')
    }
  }
  return out
}
