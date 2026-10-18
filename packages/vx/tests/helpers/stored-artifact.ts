// A key's stored artifact: a `.tar.zst` at `outputsPath`, or the `.tree`
// directory beside it. A test that damages, removes or reads the stored
// bytes goes through here, so it reaches the copy a restore reads.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Cache } from '../../src/cache/index.js'

export function storedArtifact(cache: Cache, hash: string): Uint8Array | null {
  const file = cache.outputsPath(hash)
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null
}

/** Put `bytes` where the key's artifact is, as damage on disk would. */
export function replaceStoredArtifact(cache: Cache, hash: string, bytes: Uint8Array): void {
  writeFileSync(cache.outputsPath(hash), bytes)
}

/** Remove the key's artifact and leave its rows: a hand-deleted file, a raced prune. */
export function removeStoredArtifact(cache: Cache, hash: string): void {
  rmSync(cache.outputsPath(hash), { force: true })
  rmSync(treeOf(cache, hash), { recursive: true, force: true })
}

/** The key's `.tree` form's directory. */
export const treeOf = (cache: Cache, hash: string): string =>
  cache.outputsPath(hash).replace(/\.tar\.zst$/, '.tree')

/**
 * The keys with an artifact in a store directory, a `<hash>.tar.zst` file
 * or a `<hash>.tree` directory, sorted: what a test that listed the files asked.
 */
export function storedKeys(dir: string): string[] {
  return [
    ...new Set(
      readdirSync(dir)
        .filter((n) => /^[0-9a-f]{16}\.(tar\.zst|tree)$/.test(n))
        .map((n) => n.slice(0, 16)),
    ),
  ].sort()
}

/**
 * Every stored `*.tar.zst` artifact's bytes under `root`, by where each
 * lives: what a test that scanned to prove something never landed scans.
 */
export function storedBytesUnder(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const f of new Bun.Glob('**/*.tar.zst').scanSync({ cwd: root, dot: true })) {
    out.set(f, new Uint8Array(readFileSync(path.join(root, f))))
  }
  return out
}
