// The cache key, derived. `foldKey` is all `Cache.key` computes, with the file
// hasher and the relative path passed in, so the fold runs wherever xxh3 does:
// the CLI and a remote layer.

import { xxh3, xxh3hex } from '../util/index.js'
import type { CacheKeyInput } from './layer.js'

// Bump when stored bytes are wrong under an unchanged key, or the artifact's
// container changes. A key-derivation fix whose old keys were already wrong
// heals itself and needs no bump.
export const CACHE_VERSION = 'vx-cache-v56'

/**
 * The digest folded for an input gone between enumeration and hash (a `clean`
 * ahead of a `build` deleting what the dependant's globs matched). No file has
 * it, so a run that finds the file keys apart.
 */
export const ABSENT_INPUT = 'absent'

/** `ABSENT_INPUT` for a file that is not there to read; any other error rethrown. */
export function absentOr(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return ABSENT_INPUT
  throw err
}

/**
 * Fold one task's key inputs into its 16-hex key. `hashFile` answers for a file
 * `fileHashes` does not cover; `relOf` renders a path relative to
 * `input.workspaceRoot`, POSIX-separated.
 */
export async function foldKey(
  input: CacheKeyInput,
  hashFile: (file: string) => Promise<string>,
  relOf: (file: string) => string,
  /**
   * The digest a value-bearing capture row holds. `Cache` salts it; the default
   * is for a caller that persists and prints nothing.
   */
  digestValue: (value: string) => string = xxh3hex,
  /**
   * The content behind a symlinked input, folded after the link's target
   * string. Absent, a link folds its target string alone.
   */
  behind?: (link: string) => Promise<string>,
): Promise<string> {
  const cap = input.captureInto
  let h = foldHead(input, digestValue)

  // `resolveFiles` returns sorted paths: check the order linearly and sort only
  // when needed (a copy-and-sort was 7.4 ms of a 44-task run). `>` compares
  // UTF-16 units, as `sort` does.
  let sortedInputs: readonly string[] = input.inputFiles
  for (let i = 1; i < sortedInputs.length; i++) {
    if (sortedInputs[i - 1]! > sortedInputs[i]!) {
      sortedInputs = [...input.inputFiles].sort()
      break
    }
  }
  h = xxh3(`inputs:${sortedInputs.length}`, h)
  // Per-file hash source, in order: the index-OID map (clean tracked files, no
  // I/O), hashFile's stat memo, a full blob-OID computation. All describe the
  // WORKTREE bytes the task reads: the map holds only paths whose worktree and
  // index forms match, since a clean filter makes the index blob different
  // bytes. When the map covers every file there is nothing to await, so one
  // pass fills the array and the first gap falls back to the awaited form.
  let fileHashes: readonly string[] | undefined
  const provided = input.fileHashes
  if (provided !== undefined) {
    const out: string[] = []
    for (const file of sortedInputs) {
      const oid = provided.get(file)
      if (oid === undefined) break
      out.push(oid)
    }
    if (out.length === sortedInputs.length) fileHashes = out
  }
  fileHashes ??= await Promise.all(
    sortedInputs.map((f) => provided?.get(f) ?? hashFile(f).catch(absentOr)),
  )
  // Links are rare, so a list without one awaits nothing more.
  let behindLinks: Map<number, string> | undefined
  if (behind !== undefined) {
    const links: number[] = []
    for (let i = 0; i < fileHashes.length; i++)
      if (fileHashes[i]!.startsWith('120000:')) links.push(i)
    if (links.length > 0) {
      const digests = await Promise.all(links.map((i) => behind(sortedInputs[i]!)))
      behindLinks = new Map(links.map((i, n) => [i, digests[n]!]))
    }
  }
  for (let i = 0; i < sortedInputs.length; i++) {
    const file = sortedInputs[i]!
    const rel = relOf(file)
    const oid = fileHashes[i]!
    const linked = behindLinks?.get(i)
    // A link folds what it points to in its own step, so a key without one is unchanged.
    h = xxh3(linked === undefined ? `${rel}\0${oid}` : `${rel}\0${oid}\0${linked}`, h)
    // The OID is already awaited — file capture is zero extra I/O.
    if (cap) cap.push({ kind: 'file', name: rel, hash: oid })
    if (linked !== undefined && cap) cap.push({ kind: 'linked', name: rel, hash: xxh3hex(linked) })
  }

  return h.toString(16).padStart(16, '0')
}

/**
 * The fold up to the input files, which come last. `computeTaskHash` asks it
 * alone when a remembered fold of the same files answers the rest (`FoldMemo`).
 */
export function foldHead(
  input: CacheKeyInput,
  digestValue: (value: string) => string = xxh3hex,
): bigint {
  // Seed-chained xxh3: each step folds one labelled field into the running
  // digest, so adjacent fields cannot collide by concatenation. Field order
  // matters. Each `cap` push mirrors the fold beside it, so the recorded set
  // cannot drift from the key.
  const cap = input.captureInto
  let h = xxh3(CACHE_VERSION)
  h = xxh3(`task:${input.taskId}`, h)
  h = xxh3(`config:${input.taskConfigHash}`, h)
  if (cap) {
    // Recorded so `vx why` can name a key that moved only because vx keys
    // differently now (an upgrade).
    cap.push({ kind: 'format', name: 'cache-version', hash: CACHE_VERSION })
    cap.push({ kind: 'config', name: 'config', hash: input.taskConfigHash })
  }

  // `cap` stores a salted DIGEST of each component, never the raw value: env,
  // runtime output and forwarded args may be secrets, and `vx why` prints the
  // digest. A diff needs only to know a component changed. The key folds the
  // plaintext separately.
  const forwarded = input.forwardArgs ?? []
  h = xxh3(`forward-args:${forwarded.length}`, h)
  for (const a of forwarded) h = xxh3(a, h)
  if (cap && forwarded.length > 0) {
    cap.push({ kind: 'forward', name: 'argv', hash: digestValue(JSON.stringify(forwarded)) })
  }

  h = xxh3(`env-values:${input.envValues.length}`, h)
  // \0 delimiter, not `=`: `A` + `B=C` must never fold the bytes of `A=B` +
  // `C`. An unset name folds its bare name, which no `name\0value` matches.
  for (const [n, v] of input.envValues) h = xxh3(v === undefined ? n : `${n}\0${v}`, h)
  if (cap)
    for (const [n, v] of input.envValues)
      cap.push({ kind: 'env', name: n, hash: v === undefined ? 'unset' : digestValue(v) })

  const runtimeValues = input.runtimeValues ?? []
  h = xxh3(`runtime-values:${runtimeValues.length}`, h)
  for (const [c, o] of runtimeValues) h = xxh3(`${c}\0${o}`, h)
  if (cap)
    for (const [c, o] of runtimeValues) cap.push({ kind: 'runtime', name: c, hash: digestValue(o) })

  const wsRuntimeValues = input.workspaceRuntimeValues ?? []
  h = xxh3(`ws-runtime-values:${wsRuntimeValues.length}`, h)
  for (const [c, o] of wsRuntimeValues) h = xxh3(`${c}\0${o}`, h)
  if (cap)
    for (const [c, o] of wsRuntimeValues)
      cap.push({ kind: 'ws-runtime', name: c, hash: digestValue(o) })

  const upstream = [...input.upstreamHashes].sort()
  h = xxh3(`upstream:${upstream.length}`, h)
  for (const u of upstream) h = xxh3(u, h)
  if (cap) {
    for (const u of upstream) {
      cap.push({ kind: 'upstream', name: input.upstreamIds?.get(u) ?? u, hash: u })
    }
  }

  const pluginParts = input.pluginParts ?? []
  if (pluginParts.length > 0) {
    h = xxh3(`plugin:${pluginParts.length}`, h)
    for (const [n, v] of pluginParts) h = xxh3(`${n}\0${v}`, h)
    if (cap) {
      for (const [n, v] of pluginParts) cap.push({ kind: 'plugin', name: n, hash: digestValue(v) })
    }
  }
  if (input.platform !== undefined) {
    h = xxh3(`platform:${input.platform}`, h)
    if (cap) cap.push({ kind: 'platform', name: 'platform', hash: input.platform })
  }
  return h
}
