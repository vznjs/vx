// The cache key, derived: `foldKey` is the whole of what `Cache.key` computes,
// with the two things it read off the class (the file hasher and the
// workspace-relative path) passed in. Nothing here touches a store, so the
// fold runs wherever xxh3 does: the CLI, a remote layer, and the site's
// playground, which bundles this file to derive the keys the CLI would
// (design/playground-spike-2026-09.md, P1; item 691).

import { xxh3, xxh3hex } from '../util/index.js'
import type { CacheKeyInput } from './layer.js'

// v17: artifact carries only logs + outputs (stdout + outputs/<rel>).
// Local and remote layers transport the SAME tar.zst bytes — no
// separate stage/meta.json/tar.gz dance for remote, no
// `cache-archive.ts`. stderr is no longer cached: we only cache
// successful runs and stderr is rarely meaningful on success.
// v19: '^task' dependsOn expansion switched from transitive-deps to
// nearest-holder frontier — upstream-hash sets shrink, so keys change.
// v20: input-file content hashes switched from xxh3 to git blob OIDs
// (Turbo parity). Clean tracked files take their OID straight from
// the index (harvested by the bulk `git ls-files -s`); dirty /
// untracked files get the identical OID computed in-process. Every
// file's hash bytes change → bump. SCHEMA_VERSION moves with it:
// pre-v20 `file_hashes.content_hash` rows hold xxh3 digests that
// must not leak into the OID domain via the mtime+size memo.
// v22: reverted the v21 output-fold "early cutoff". Downstream keys
// fold the upstream's INPUT key (its task hash) again — pure-input
// transitive hashing (Turbo/Nx model). No output content participates
// in any cache key. SCHEMA v21 drops the now-unused outputs_hash
// column. Early cutoff removed (an upstream that re-emits identical
// output still re-runs dependents) — rare, not worth the cascade.
// v23: fold cache.inputs.runtime / workspaceRuntime command output into
// the key (two namespaced sections after env-values). Command strings
// live in the resolved config (frozen by `vx lock`); the OUTPUT is
// resolved live every run, so it stays correct under --frozen. No
// SCHEMA bump — only Cache.key derivation changed.
// v24: vx-lock.json added to the always-ignored input set (cache/
// inputs.ts ALWAYS_IGNORE). A task whose globs matched the root
// lockfile (broad `**/*` on the root project) drops it from the hashed
// file set, so those keys change; tasks that never matched it are
// byte-identical. No SCHEMA bump — only the input file set changed.
//
// CACHE_VERSION stays v24 through the Tier-3 schema roll (SCHEMA v22).
// Tier 3 persists the very components already fed to `Cache.key()` —
// it adds nothing to, reorders nothing in, and reweights nothing
// inside the key fold (the new `captureInto` sink is a pure
// side-channel). A task's hash is byte-identical before and after, so
// existing artifacts stay valid and there is no cache-version bump.
// v25: the ARTIFACT BYTES are wrong in every existing entry, while the
// key that addresses them is unchanged — the one situation a version
// bump exists for. Two defects: (a) `packArtifact` staged outputs with
// `Bun.write`, which does not carry the source mode, so every artifact
// records 0644 and a cache hit strips the executable bit off any binary
// or generated script; (b) it packed `--format=ustar`, which splits a
// name over 100 bytes into prefix+name, and the reader read only `name`
// — so those entries lost their `outputs/` prefix and were silently
// dropped from both the restore and the output_files index. Neither is
// self-healing: the stored bytes/headers are already wrong, so without a
// new namespace the fixed code would keep replaying them forever.
// v26: same situation, different producer. A task whose child was killed by
// a shutdown signal reported `aborted`, but `aborted` did not propagate to
// dependents — so a dependent ran against PARTIAL outputs, succeeded, and
// cached what it built. The fold takes the upstream's INPUT key, which a
// signal does not change, so that entry sits under exactly the key a healthy
// run derives and replays forever as a green hit. Fixing the propagation
// stops new poison but cannot reach entries already written, and a
// `LayeredCache` uploads them, so the reach is a whole team's shared cache
// rather than one developer's disk. Pre-alpha, so one cold rebuild is the
// cheap side of that trade.
// v28: the same shape again (item 667). An output glob over a bracket route
// directory (`app/[id]/page.js`) was read as a character class, so its
// entries saved nothing (or the class's namesakes) under a key the fix
// leaves unchanged: the glob text is what folds. Read literally, the first
// hit on such an entry cleaned the route and restored nothing, green.
// v29: every key moves (item 682). The seed-chained fold carried only 32
// bits of state (Bun's xxHash3 reads the low half of its seed), so two
// input sets could share a key; `xxh3` now feeds the seed forward. The
// old keys were wrong, not their bytes, so this is self-healing; the bump
// is for the first run's notice, since every entry misses once.
// v30: stored bytes wrong under an unchanged key (item 720). npm and Yarn
// link every workspace package at the root, the task's own included, and
// the sandbox granted that link's target whole: a sandboxed task read an
// undeclared file of its own project unreported and saved what it built.
// The fix withholds the self-link, but the key never saw the file, so an
// entry saved before it hits forever when only that file changes.
// v31: the same shape for a sibling (item 726). A cached sandboxed task was
// granted every linked workspace package, so it read a sibling its key
// never folded and saved what it built. The fix withholds that link unless
// the key answers for the package, but an entry saved before it still hits
// after the sibling changes (probed: the old output replayed).
export const CACHE_VERSION = 'vx-cache-v31'

/**
 * Fold one task's key inputs into its 16-hex cache key. `hashFile` answers
 * for an input file the caller's `fileHashes` map does not cover (the git
 * blob OID of its worktree bytes); `relOf` renders an input file relative to
 * `input.workspaceRoot`, POSIX-separated.
 */
export async function foldKey(
  input: CacheKeyInput,
  hashFile: (file: string) => Promise<string>,
  relOf: (file: string) => string,
): Promise<string> {
  // Seed-chained xxHash3: each step folds one field into the
  // running digest via `xxh3(part, prevDigest)`. Equivalent to the
  // old CryptoHasher.update() pattern, no intermediate buffer.
  // Field-order matters; each line is prefixed with its label so
  // adjacent fields can't collide via concat.
  // Optional capture sink — see CacheKeyInput.captureInto. Pure
  // side-channel; every push below mirrors the fold immediately
  // above/beside it so the recorded set can't drift from the key.
  const cap = input.captureInto
  let h = xxh3(CACHE_VERSION)
  h = xxh3(`task:${input.taskId}`, h)
  h = xxh3(`workspace:${input.workspaceFingerprint}`, h)
  h = xxh3(`pkg:${input.projectPackageJsonHash}`, h)
  h = xxh3(`config:${input.taskConfigHash}`, h)
  if (cap) {
    cap.push({ kind: 'workspace', name: 'fingerprint', hash: input.workspaceFingerprint })
    cap.push({ kind: 'package', name: 'package.json', hash: input.projectPackageJsonHash })
    cap.push({ kind: 'config', name: 'config', hash: input.taskConfigHash })
  }

  // NOTE on `cap` (entry_inputs capture): the `hash` field stores a
  // DIGEST of each component, never the raw value. For value-bearing kinds
  // (env, runtime, ws-runtime, forward) the payload is a secret or
  // sensitive string (API keys via cache.inputs.env, runtime-command
  // output, args after `--`), so we push `xxh3hex(v)` — the diff consumer
  // only needs to know whether a component CHANGED, which a digest
  // preserves losslessly. cache.db must never hold plaintext secrets at
  // rest. The cache KEY (`h`) folds the plaintext separately below and is
  // unaffected.
  const forwarded = input.forwardArgs ?? []
  h = xxh3(`forward-args:${forwarded.length}`, h)
  for (const a of forwarded) h = xxh3(a, h)
  if (cap && forwarded.length > 0) {
    cap.push({ kind: 'forward', name: 'argv', hash: xxh3hex(JSON.stringify(forwarded)) })
  }

  h = xxh3(`env-values:${input.envValues.length}`, h)
  // \0 delimiter, not `=`: names and values may themselves contain
  // `=`, and `A` + `B=C` must never fold the same bytes as `A=B` + `C`.
  for (const [n, v] of input.envValues) h = xxh3(`${n}\0${v}`, h)
  if (cap)
    for (const [n, v] of input.envValues) cap.push({ kind: 'env', name: n, hash: xxh3hex(v) })

  const runtimeValues = input.runtimeValues ?? []
  h = xxh3(`runtime-values:${runtimeValues.length}`, h)
  for (const [c, o] of runtimeValues) h = xxh3(`${c}\0${o}`, h)
  if (cap)
    for (const [c, o] of runtimeValues) cap.push({ kind: 'runtime', name: c, hash: xxh3hex(o) })

  const wsRuntimeValues = input.workspaceRuntimeValues ?? []
  h = xxh3(`ws-runtime-values:${wsRuntimeValues.length}`, h)
  for (const [c, o] of wsRuntimeValues) h = xxh3(`${c}\0${o}`, h)
  if (cap)
    for (const [c, o] of wsRuntimeValues)
      cap.push({ kind: 'ws-runtime', name: c, hash: xxh3hex(o) })

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
      for (const [n, v] of pluginParts) cap.push({ kind: 'plugin', name: n, hash: xxh3hex(v) })
    }
  }

  // `resolveFiles` already returns its paths sorted, and a copy-and-sort
  // of three thousand strings per task is not free: 7.4 ms of a 44-task
  // run here (2026-09-20). A linear order check costs one comparison per
  // file instead of n log n, and a caller that hands over an unsorted set
  // — a plugin's own input list — still gets one. `>` on strings compares
  // UTF-16 code units, which is what a comparator-less `sort` does.
  let sortedInputs: readonly string[] = input.inputFiles
  for (let i = 1; i < sortedInputs.length; i++) {
    if (sortedInputs[i - 1]! > sortedInputs[i]!) {
      sortedInputs = [...input.inputFiles].sort()
      break
    }
  }
  h = xxh3(`inputs:${sortedInputs.length}`, h)
  // Per-file hash source, in preference order: the caller-supplied
  // index-OID map (clean tracked files — zero I/O), then hashFile's
  // stat memo (no read), then a full in-process blob-OID computation.
  // All three describe the WORKTREE bytes, which is what the task
  // reads — the index-OID map is only populated for paths whose
  // worktree form matches their index form, because a clean filter
  // (`text`/`eol`/`ident`) makes the index blob a DIFFERENT sequence
  // of bytes and folding it would let two distinct worktree contents
  // share a key. The fold order is locked to `sortedInputs` so
  // results are stable across runs.
  // The common warm shape is that the caller's OID map covers every file,
  // and then there is nothing to await: building three thousand promises
  // per task to resolve values already in hand cost 8.4 ms of that same
  // run. One pass fills the array, and the first gap falls back to the
  // awaited form for the whole list.
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
  fileHashes ??= await Promise.all(sortedInputs.map((f) => provided?.get(f) ?? hashFile(f)))
  for (let i = 0; i < sortedInputs.length; i++) {
    const file = sortedInputs[i]!
    const rel = relOf(file)
    const oid = fileHashes[i]!
    h = xxh3(`${rel}\0${oid}`, h)
    // The OID is already awaited — file capture is zero extra I/O.
    if (cap) cap.push({ kind: 'file', name: rel, hash: oid })
  }

  return h.toString(16).padStart(16, '0')
}
