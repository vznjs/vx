// Cache-correctness verification (Phase 1: determinism). Pure helpers for the
// `vx run --verify` hook in execute-task.ts: content-fingerprint a task's
// output tree (mtime-independent) and diff two runs' trees, so a task whose
// outputs are NOT a pure function of its declared inputs — a non-hermetic task
// whose cache entry would replay arbitrary past bytes — is caught and named.
// See docs/design/cache-correctness-2026-07.md.

import path from 'node:path'
import type { CacheLayer } from '../cache/index.js'
import type { TaskOutcome, VerifyVerdict } from '../graph/index.js'

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

/** Content-fingerprint an output tree: key → git-blob OID. Reuses the same
 *  `Cache.hashFile` primitive the input hashing folds, so it's byte-true and
 *  mtime-independent — two byte-identical trees produce equal fingerprints
 *  even though their tar.zst artifacts (which embed mtimes) would differ. */
export async function hashOutputTree(
  cache: CacheLayer,
  refs: readonly OutputRef[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const r of refs) out.set(r.key, await cache.hashFile(r.abs))
  return out
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
        proven++
        break
      case 'nondeterministic':
      case 'rerun-failed':
        bad++
        break
      case 'allowed-nondeterministic':
      case 'no-outputs':
        na++
        break
      case 'not-verified':
        notVerified++
        break
    }
  }
  const lines = [
    '',
    `  Verify:   ${proven} proven · ${bad} nondeterministic · ${na} n/a · ${notVerified} not-verified`,
  ]
  for (const o of outcomes) {
    const v = o.verify
    if (v === undefined) continue
    if (v.kind === 'nondeterministic') {
      lines.push(`    ✗ ${o.node.id} — nondeterministic`)
      lines.push(`        changed: ${v.changed.join(', ')}`)
    } else if (v.kind === 'rerun-failed') {
      lines.push(`    ✗ ${o.node.id} — verify re-run failed (exit ${v.exitCode})`)
    } else if (v.kind === 'allowed-nondeterministic') {
      lines.push(`    ⚠ ${o.node.id} — nondeterministic (allowed)`)
    }
  }
  return lines
}
