// Cache-correctness verification (Phase 1: determinism). Pure helpers for the
// `vx run --verify` hook in execute-task.ts: content-fingerprint a task's
// output tree (mtime-independent) and diff two runs' trees, so a task whose
// outputs are NOT a pure function of its declared inputs — a non-hermetic task
// whose cache entry would replay arbitrary past bytes — is caught and named.
// See docs/design/cache-correctness-2026-07.md.

import path from 'node:path'
import type { OutputFingerprint, TaskOutcome, VerifyVerdict } from '../graph/index.js'
import { xxh3hex } from '../util/index.js'

/** An output file to fingerprint: absolute path + a stable, run-independent
 *  key (project-relative, or `workspace-outputs/<rel-to-root>` for workspace
 *  outputs — matching the cache artifact's namespace so the two never collide). */
export interface OutputRef {
  abs: string
  key: string
}

/** Build the fingerprint key set from a task's resolved output paths. */
export function outputRefs(
  projectDir: string,
  outputFiles: readonly string[],
  workspaceRoot: string,
  workspaceOutputFiles: readonly string[],
): OutputRef[] {
  const rel = (from: string, abs: string): string =>
    path.relative(from, abs).split(path.sep).join('/')
  return [
    ...outputFiles.map((abs) => ({ abs, key: rel(projectDir, abs) })),
    ...workspaceOutputFiles.map((abs) => ({
      abs,
      key: `workspace-outputs/${rel(workspaceRoot, abs)}`,
    })),
  ]
}

/** Content-fingerprint an output tree: key → xxh3 of the file's BYTES, read
 *  unconditionally from disk. Deliberately NOT `Cache.hashFile`: its
 *  mtime+size memo would return attempt 1's digest for a re-run output with
 *  equal size and mtime (e.g. a build that normalizes mtimes — standard
 *  reproducible-build practice), silently proving a divergent task
 *  deterministic. fp1/fp2 are only ever compared to each other, so any
 *  content hash works — and the proof must not trust a cache. */
export async function hashOutputTree(refs: readonly OutputRef[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const r of refs) {
    out.set(r.key, xxh3hex(new Uint8Array(await Bun.file(r.abs).arrayBuffer())))
  }
  return out
}

/** Per-file map cap on a shipped fingerprint (~40 KB at the cap). The tree
 *  digest always folds ALL entries, so detection never depends on the map. */
const FP_MAX_FILES = 500

/** Roll an output-tree fingerprint map into the shippable `OutputFingerprint`
 *  payload (Phase 4, cross-machine diff): a tree digest over ALL sorted
 *  entries folded `key\0hash\n` (\0 boundaries so parts can't alias), plus
 *  the first-`cap` pairs — deterministic truncation, so two machines'
 *  truncated maps cover the same key subset and stay diffable. */
export function foldFingerprint(fp: Map<string, string>, cap = FP_MAX_FILES): OutputFingerprint {
  const keys = [...fp.keys()].sort()
  let folded = ''
  for (const k of keys) folded += `${k}\0${fp.get(k)!}\n`
  return {
    tree: xxh3hex(folded),
    fileCount: keys.length,
    files: keys.slice(0, cap).map((k) => [k, fp.get(k)!] as const),
    ...(keys.length > cap ? { truncated: true } : {}),
  }
}

/** The output keys whose content OID differs between two fingerprints
 *  (added, removed, or changed), sorted. */
export function diffOutputTrees(a: Map<string, string>, b: Map<string, string>): string[] {
  const changed: string[] = []
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(k) !== b.get(k)) changed.push(k)
  }
  return changed.sort()
}

/** Turn a determinism diff into a verdict, honoring the `--verify-allow`
 *  escape hatch (an allowed divergence is reported but never fails the run). */
export function classifyDeterminism(changed: readonly string[], allowed: boolean): VerifyVerdict {
  if (changed.length === 0) return { kind: 'proven-deterministic' }
  return allowed
    ? { kind: 'allowed-nondeterministic', changed }
    : { kind: 'nondeterministic', changed }
}

/** Extract the workspace-relative paths a task read outside its declared inputs
 *  (Phase 2, `--verify=inputs`). A strace-derived violation line carries the
 *  offending absolute path in trailing brackets (`… [/abs/path]`); pull it out,
 *  make it workspace-relative, dedup, and sort. Lines without a bracketed path
 *  (e.g. macOS syscall lines) fall back to the raw line so nothing is lost. */
export function undeclaredInputPaths(
  violations: readonly { line: string }[],
  workspaceRoot: string,
): string[] {
  const rels = new Set<string>()
  for (const v of violations) {
    // Two wire shapes: Linux strace lines carry `[path]`; macOS
    // sandbox-exec lines end in a bare absolute path
    // (`node(123) deny(1) file-read-data /abs/path`). Fall back to the
    // raw line only when neither parses — a path the user can act on
    // beats a log line every time.
    const m = /\[([^\]]+)\]\s*$/.exec(v.line) ?? /\s(\/\S+)\s*$/.exec(v.line)
    const raw = m ? m[1]! : v.line
    rels.add(
      path.isAbsolute(raw) ? path.relative(workspaceRoot, raw).split(path.sep).join('/') : raw,
    )
  }
  return [...rels].sort()
}

/** The end-of-run `--verify` summary section: a counts line plus a
 *  failures block naming each non-hermetic task and its diverging outputs.
 *  Empty when no task carried a verdict. */
export function formatVerifySection(outcomes: readonly TaskOutcome[]): string[] {
  const verdicts = outcomes.filter((o) => o.verify !== undefined)
  if (verdicts.length === 0) return []
  let proven = 0
  let bad = 0
  let na = 0
  let notVerified = 0
  for (const o of verdicts) {
    switch (o.verify!.kind) {
      case 'proven-deterministic':
      case 'proven-complete':
        proven++
        break
      case 'nondeterministic':
      case 'rerun-failed':
      case 'undeclared-inputs':
        bad++
        break
      case 'allowed-nondeterministic':
      case 'no-outputs':
        na++
        break
      case 'not-verified':
        notVerified++
        break
      case 'unverifiable-remote-only':
        na++
        break
    }
  }
  const lines = [
    '',
    `  Verify:   ${proven} proven · ${bad} unsafe · ${na} n/a · ${notVerified} not-verified`,
  ]
  for (const o of outcomes) {
    const v = o.verify
    if (v === undefined) continue
    if (v.kind === 'nondeterministic') {
      lines.push(`    ✗ ${o.node.id} — nondeterministic`)
      lines.push(`        changed: ${v.changed.join(', ')}`)
    } else if (v.kind === 'undeclared-inputs') {
      lines.push(`    ✗ ${o.node.id} — read undeclared inputs`)
      if (v.paths.length > 0) lines.push(`        ${v.paths.join(', ')}`)
      lines.push('        add them to cache.inputs.files / workspaceFiles')
    } else if (v.kind === 'rerun-failed') {
      lines.push(`    ✗ ${o.node.id} — verify re-run failed (exit ${v.exitCode})`)
    } else if (v.kind === 'unverifiable-remote-only') {
      lines.push(`    ⚠ ${o.node.id} — remote-only: no local execution to prove (unverified)`)
    } else if (v.kind === 'allowed-nondeterministic') {
      lines.push(`    ⚠ ${o.node.id} — nondeterministic (allowed)`)
    }
  }
  return lines
}
