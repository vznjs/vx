// Global test harness guard — preloaded by the `test` task
// (`bun test --preload ./tests/setup.ts`).
//
// Bun runs every test file sequentially in ONE process and does NOT restore
// process.cwd() at the file boundary (empirically verified: a file that
// process.chdir()s into a temp dir and doesn't restore leaks that cwd into the
// next file). If that dir is later rm'd, the next file runs against a deleted
// cwd — the historical `vx watch` e2e flake (`git ls-files` → "Unable to read
// current working directory"). Each chdir'ing suite already restores cwd in its
// own afterEach, but this global guard makes the whole flake class structurally
// impossible: any test may chdir freely and the harness cleans up after it.
//
// The restore is a no-op on the normal path (cwd already at the root), so it
// costs nothing when suites behave; it only bites when one forgets to restore.

import { afterEach } from 'bun:test'

const rootCwd = process.cwd()

afterEach(() => {
  if (process.cwd() !== rootCwd) process.chdir(rootCwd)
})
